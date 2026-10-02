/**
 * Supabase "Before User Created" hook.
 *
 * ### Why this platform
 *
 * Screening must happen before the action it protects, and an integration that
 * only observes a post-signup webhook must not be described as preventing
 * signup. Checked against each vendor's documentation:
 *
 *   Supabase  `before-user-created` runs before the user row exists and a 4xx
 *             with an `error` object denies the signup. The endpoint is the
 *             customer's, so the whole path is testable. CHOSEN.
 *   Auth0     `pre-user-registration` is equally real, but runs inside a
 *             tenant nothing outside it can execute.
 *   Clerk     No pre-signup server hook. `user.created` fires after the
 *             account exists, which is the case the criterion warns about.
 *
 * ### The time budget, which is the thing that shapes this file
 *
 * Supabase documents **5 seconds for the entire invocation, including its own
 * retries**, and a hook that does not answer in time **fails the signup**.
 *
 * That last part matters more than it looks. "Fail open" is not a thing you
 * get by doing nothing: if this handler does not RETURN in time, Supabase
 * errors the signup regardless of what you intended. Allowing a signup through
 * an outage means *answering 200 quickly*, not timing out quietly.
 *
 * So the budget is explicit and conservative:
 *
 *   5000 ms   Supabase's total, including its retries
 *  -1000 ms   margin: network to and from Supabase, their overhead, GC
 *   ------
 *   4000 ms   this handler's ceiling
 *  -1500 ms   headroom to serialise and return an answer after a slow call
 *   ------
 *   2500 ms   default ceiling for the screening call            (SCREEN_MS)
 *
 * And **one attempt, never a retry**. A retry inside a 5-second budget that
 * already contains Supabase's own retries is how a hook that was merely slow
 * becomes a hook that never answers. The Orisift SDK client is deliberately
 * not used here for the same reason: it retries and honours `Retry-After`,
 * which is right for a background job and wrong inside someone's signup.
 *
 * ### What it will not decide for you
 *
 * `onUnavailable` is required. There is no default, because the default would
 * be this library deciding whether your product accepts people it could not
 * screen.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/* ------------------------------ the budget ------------------------------- */

/*
 * THREE DIFFERENT DEADLINES. Reporting conflated two of them once, so they are
 * named apart here and the names are what reports should use.
 *
 *   SUPABASE_HOOK_BUDGET_MS   Supabase's. The whole invocation, their retries
 *                             included. Not ours to change.
 *   HANDLER_CEILING_MS        Ours. Everything this handler may take, from the
 *                             first byte of the request to the last byte of
 *                             the response. A budget we must stay inside, not
 *                             a timer we set.
 *   SCREENING_DEADLINE_MS     Ours, and the only one that is actually armed.
 *                             The AbortController on the call to Orisift. It
 *                             is the figure a "timeout" is measured against.
 *
 * A successful request finishing in 973 ms says something about the normal
 * path and nothing about any of these. Only a call that actually overruns
 * SCREENING_DEADLINE_MS tests the abort, and only measuring the handler's total
 * time on that path tests whether HANDLER_CEILING_MS holds.
 */

/** Supabase's documented total for the whole invocation, including retries. */
export const SUPABASE_HOOK_BUDGET_MS = 5_000;
/** Margin left to Supabase: transport both ways plus their own overhead. */
export const TRANSPORT_MARGIN_MS = 1_000;
/** Everything this handler may take. A budget, not an armed timer. */
export const HANDLER_CEILING_MS = SUPABASE_HOOK_BUDGET_MS - TRANSPORT_MARGIN_MS;
/** Reserved so a screening that overruns still leaves time to answer. */
export const RESPONSE_HEADROOM_MS = 1_500;
/**
 * The armed deadline: the AbortController on the call to Orisift.
 *
 * This is what a reported `timeout` is measured against, and the only one of
 * the three that causes anything to happen.
 */
export const SCREENING_DEADLINE_MS = HANDLER_CEILING_MS - RESPONSE_HEADROOM_MS;
/** @deprecated Use `SCREENING_DEADLINE_MS`; the old name hid which deadline it was. */
export const DEFAULT_SCREEN_MS = SCREENING_DEADLINE_MS;

/* ------------------------------ the contract ----------------------------- */

export interface BeforeUserCreatedPayload {
  metadata: { uuid: string; time: string; name: string; ip_address?: string };
  user: {
    id: string;
    email?: string;
    phone?: string;
    app_metadata?: { provider?: string; providers?: string[] };
    user_metadata?: Record<string, unknown>;
    is_anonymous?: boolean;
  };
}

export type Enforcement = "allow" | "challenge" | "review_queue" | "block" | "fix_request";

export interface ScreeningDecision {
  enforcement: Enforcement;
  action: string | null;
  audience: "caller" | "end_user" | null;
  callerActionable: boolean;
  endUserReasons: Array<{ input: string; code: string; message: string }>;
  callerReasons: Array<{ input: string; code: string; message: string }>;
  stillOutstanding: string[];
  screeningId?: string | null;
}

/**
 * Why a screening did not produce a decision.
 *
 * Separated because they are separate operational problems with separate
 * remedies, and an operator seeing one number cannot tell which they have.
 */
export type UnavailableReason =
  /** The Orisift key is missing, invalid, revoked, or the account suspended. */
  | "auth_failed"
  /** The account cannot pay for the screening. */
  | "insufficient_credits"
  /** Rate limited by Orisift. */
  | "rate_limited"
  /** Orisift refused the request as malformed. Your integration is wrong. */
  | "invalid_request"
  /** Orisift errored. */
  | "server_error"
  /** We stopped waiting. */
  | "timeout"
  /** The deduplication store could not be reached, so nothing was screened. */
  | "dedupe_unavailable"
  /** DNS, TLS, connection refused. */
  | "unreachable"
  /** 200, but not a screening. A proxy or captive portal, usually. */
  | "malformed_response"
  /** YOUR `decide` threw. An unmapped action, most likely. */
  | "decide_threw";

export interface UnavailableEvent {
  reason: UnavailableReason;
  /** HTTP status, where there was one. */
  status?: number;
  /** For logs. Never contains the key and never reaches the end user. */
  detail: string;
  /** What the handler did about it, from your `onUnavailable`. */
  applied: "allow" | "deny";
  elapsedMs: number;
  /** Supabase's `webhook-id`. The same delivery retried carries the same one. */
  hookMessageId: string;
  /**
   * Exactly what was sent to Orisift as `Idempotency-Key`, derived from
   * `metadata.uuid`.
   *
   * Logged so a delivery, its retries and the charge can be correlated
   * afterwards without keeping the payload, which contains the address of
   * someone signing up. Empty when the payload never parsed.
   */
  idempotencyKey: string;
  /**
   * Which deduplication mode was in force, whether this delivery REUSED a key
   * another delivery had already claimed, and why it could not.
   *
   * Worth alerting on. `dedupeShared` never becoming true under retry load
   * means deduplication is not working and you are paying per delivery;
   * `dedupeDegraded` naming a store failure means the same, with a cause.
   */
  dedupeMode: DedupeMode;
  dedupeShared: boolean;
  dedupeDegraded: string | null;
}

export interface DecisionEvent {
  decision: ScreeningDecision;
  /** True only when Orisift actually returned a screening. */
  screened: true;
  creditsCharged: number;
  screeningId: string | null;
  elapsedMs: number;
  /** Supabase's `webhook-id`. The same delivery retried carries the same one. */
  hookMessageId: string;
  /** Exactly what was sent to Orisift as `Idempotency-Key`. See UnavailableEvent. */
  idempotencyKey: string;
  /**
   * Which deduplication mode was in force, whether this delivery REUSED a key
   * another delivery had already claimed, and why it could not.
   *
   * Worth alerting on. `dedupeShared` never becoming true under retry load
   * means deduplication is not working and you are paying per delivery;
   * `dedupeDegraded` naming a store failure means the same, with a cause.
   */
  dedupeMode: DedupeMode;
  dedupeShared: boolean;
  dedupeDegraded: string | null;
}

/* ===================== identity, and what it cannot be ==================== *
 *
 * Three different things get called "one signup", and keeping them apart is
 * the whole of this problem.
 *
 *   SIGNUP ATTEMPT    one person submitting a signup once. What a customer
 *                     means by "charge me once per signup".
 *                     **Supabase gives this no identifier.**
 *
 *   HOOK DELIVERY     one HTTP request to your hook. Identified by
 *                     `webhook-id`. Supabase REGENERATES this, and
 *                     `metadata.uuid`, `metadata.time` and `user.id`, on every
 *                     retry. Measured against a real project on 2026-10-01:
 *                     one attempt produced four deliveries with four of
 *                     everything and four different payload hashes.
 *
 *   SCREENING REQUEST one call to Orisift, identified by `Idempotency-Key`.
 *                     Ours to choose, and the only lever there is.
 *
 * Billing happens per SCREENING REQUEST. Customers want one per SIGNUP
 * ATTEMPT. Supabase only gives us DELIVERIES, and regenerates every identifier
 * on each one.
 *
 * ### The part that cannot be solved from the payload
 *
 * A retry of one attempt and a second, distinct attempt by the same person
 * **look identical**. Both arrive with the same email and IP, and with a fresh
 * uuid, time and user id. There is nothing in the payload that separates them.
 *
 * So no deduplication derived from the payload alone can be exactly-once per
 * attempt. Anything claiming otherwise is either merging distinct attempts and
 * calling it deduplication, or splitting retries and calling it correctness.
 * This SDK does not claim it.
 *
 * ### What it offers instead
 *
 * `dedupe` is REQUIRED and has four explicit modes, because which trade you
 * want is yours:
 *
 *   "attempt"         you supply the attempt identity. Exactly-once per
 *                     attempt, IF your identifier really is one per attempt.
 *                     The only mode that earns that phrase.
 *
 *   "shared"          bounded deduplication over shared storage you provide:
 *                     AT MOST ONE screening per fingerprint per window, across
 *                     instances and restarts.
 *
 *   "single-process"  the same, in memory, correct only while one process
 *                     handles every delivery. Named so it cannot be chosen by
 *                     accident.
 *
 *   "none"            every delivery is its own screening, and its own charge.
 */

/**
 * Agreement on one idempotency key per fingerprint, shared across instances.
 *
 * One primitive, because one is enough and more would be harder to implement
 * correctly: Redis `SET key val NX PX ttl` then `GET`, Postgres
 * `INSERT ... ON CONFLICT DO NOTHING` then `SELECT`, DynamoDB a conditional
 * put. Working implementations of both are in
 * `examples/supabase-signup-screening/stores/`.
 */
export interface AttemptKeyStore {
  /**
   * Atomically: if `key` is absent, store `candidate` to expire after `ttlMs`
   * and return `candidate`; otherwise return the value already stored and do
   * NOT extend its expiry.
   *
   * Returning `candidate` means this caller is the first for that fingerprint.
   * Returning anything else means another delivery got there first and this one
   * must use that value.
   *
   * **Atomicity is the whole contract.** A read-then-write implementation lets
   * two concurrent first deliveries both believe they are first, which is one
   * of the cases this exists to prevent.
   *
   * If it throws or is slow, the handler does NOT screen on a key of its own
   * by default, because that turns a store outage into a duplicate charge on
   * every retry. It applies your `onUnavailable` response with reason
   * `dedupe_unavailable` and makes no screening request at all. See
   * `onStoreFailure` if you want the other trade.
   */
  claim(key: string, candidate: string, ttlMs: number): Promise<string>;
}

/**
 * Default bounded-deduplication window: **two minutes**.
 *
 * ### What this window actually does
 *
 * It is NOT a bucket on the wall clock, so two deliveries a millisecond apart
 * can never land on opposite sides of an edge. It is a time-to-live on the
 * first claim: deliveries matching a fingerprint reuse that claim until it
 * expires, counted from when it was made.
 *
 * ### The trade it makes, in both directions
 *
 * **It can reuse evidence across distinct attempts.** Two genuinely separate
 * signup attempts with identical identifiers inside the window resolve to one
 * screening. The second is not billed, and it is answered with evidence
 * gathered for the first, which by then is up to `windowMs` old. If an IP's
 * reputation changed in between, the second attempt does not see it.
 *
 * **Outside the window, retries are billed separately.** A retry arriving
 * after expiry is a new screening and a new charge.
 *
 * Two minutes is chosen against measurement, not taste: the longest observed
 * retry sequence spanned 11.8 seconds, so this is roughly ten times the
 * observed need, while keeping the window in which distinct attempts get
 * merged short. Raise it to collapse longer retry storms and merge more
 * distinct attempts; lower it for fresher evidence and more duplicate charges.
 */
export const DEFAULT_DEDUPE_WINDOW_MS = 120_000;

export type DedupeMode = "attempt" | "shared" | "single-process" | "none";

export type DedupePolicy =
  /**
   * You supply the attempt identity. A stable identifier with a MATCHING
   * request reuses the screening for as long as Orisift retains the
   * idempotency record; the same identifier with a CHANGED request is a 409,
   * not a replay, and reaches you as `invalid_request`. After the screening
   * retention passes the key is REFUSED with 409 `idempotency_key_expired`:
   * nothing is screened, nothing is charged, and a new key is required. See
   * IDENTITY-AND-DEDUPLICATION-supabase.md section 4a.
   *
   * Return a value that is the same for every
   * delivery of one attempt and different for different attempts: a request id
   * your client generated and passed through `user.user_metadata`, a row id
   * from your own pre-signup table, and so on.
   *
   * Return `null` when this payload has no attempt identity, and that delivery
   * is screened on its own key and billed on its own. The event says so.
   */
  | { mode: "attempt"; attemptId: (payload: BeforeUserCreatedPayload) => string | null }
  /**
   * Bounded deduplication across instances. See AttemptKeyStore.
   *
   * `onStoreFailure` decides what happens when the store cannot be reached,
   * and it defaults to the safe answer:
   *
   *   "unavailable"  (default) NO screening request is made, and your
   *                  `onUnavailable` response is applied, with reason
   *                  `dedupe_unavailable`. Nothing is screened, nothing is
   *                  billed.
   *
   *   "screen"       screen anyway, on a key of this delivery's own.
   *                  **This is the duplicate-charge path, and it is opt-in.**
   *                  While the store is down nothing agrees on a key, so
   *                  every delivery of every attempt becomes its own
   *                  screening and its own charge. A Supabase retry storm
   *                  during a Redis outage multiplies the bill by the number
   *                  of deliveries, which is precisely the failure that
   *                  started all of this: four deliveries, four charges.
   *
   * Choose "screen" only if unscreened signups cost you more than duplicate
   * screenings do, and expect the bill.
   */
  | { mode: "shared"; store: AttemptKeyStore; windowMs?: number; onStoreFailure?: "unavailable" | "screen" }
  /** Bounded deduplication in memory. Correct only on a single process. */
  | { mode: "single-process"; windowMs?: number }
  /** No deduplication. Every delivery is screened and billed. */
  | { mode: "none" };

export interface BeforeUserCreatedOptions {
  apiKey: string;
  /** Supabase's hook secret, exactly as given: `v1,whsec_<base64>`. */
  hookSecret: string;

  /**
   * How deliveries are mapped to screening requests, and therefore to charges.
   * **Required**, like `onUnavailable`, and for the same reason: there is no
   * answer that is right for everyone and a silent default would be choosing
   * how much a customer pays and how fresh their evidence is.
   *
   * Read the identity contract above before choosing.
   */
  dedupe: DedupePolicy;

  /**
   * Separates two integrations that share one API key, such as a staging and a
   * production deployment of the same app. Without it they share a
   * deduplication scope, so a retry in one could reuse the other's screening.
   * Any stable string; it is not a secret and is never sent anywhere.
   */
  integrationId?: string;
  decide: (screening: unknown) => ScreeningDecision;
  /** Which outcomes refuse a signup. No default. */
  denyOn: readonly Enforcement[];

  /**
   * What happens when Orisift did not produce a decision. **Required.**
   *
   * `"allow"` lets the signup proceed unscreened. `"deny"` refuses it. There
   * is no default: choosing one for you would be choosing whether your product
   * accepts people it could not screen.
   *
   * Whichever you pick, `onUnavailable` fires with the specific reason, and the
   * signup is **never** recorded as screened.
   */
  onUnavailable: "allow" | "deny";

  denyMessage?: (decision: ScreeningDecision) => string;
  /** Shown when unavailable and you chose `deny`. Never carries error detail. */
  unavailableMessage?: string;

  /**
   * The armed deadline on the call to Orisift. Defaults to
   * `SCREENING_DEADLINE_MS` (2500 ms) and is capped at it.
   *
   * Not the handler's total: the handler also has to verify a signature, parse,
   * decide and serialise. `HANDLER_CEILING_MS` is that total.
   */
  screenTimeoutMs?: number;
  baseUrl?: string;
  policy?: string;

  /** Fires only when a real screening happened. */
  onDecision?: (e: DecisionEvent) => void;
  /** Fires only when one did not. Distinct reasons, for your alerting. */
  onUnavailableEvent?: (e: UnavailableEvent) => void;

  fetchImpl?: typeof fetch;
  toleranceSeconds?: number;
}

/* --------------------------- signature verification ---------------------- */

export class SignatureError extends Error {
  constructor(message: string) { super(message); this.name = "SignatureError"; }
}

/**
 * Standard Webhooks, implemented from the specification so the SDK keeps zero
 * dependencies. Signed content is `id.timestamp.body`; the secret is base64
 * after `whsec_`; the header is a space-delimited list of `v1,<base64>` and any
 * one matching passes, which is what makes rotation possible without downtime.
 */
export function verifySignature(p: {
  secret: string; id: string; timestamp: string; body: string;
  signatureHeader: string; toleranceSeconds?: number; now?: number;
}): void {
  const tolerance = p.toleranceSeconds ?? 300;
  const now = p.now ?? Math.floor(Date.now() / 1000);

  const ts = Number(p.timestamp);
  if (!Number.isFinite(ts)) throw new SignatureError("webhook-timestamp is not a number");
  if (Math.abs(now - ts) > tolerance) {
    throw new SignatureError("webhook-timestamp is outside the tolerance window");
  }

  const raw = p.secret.startsWith("v1,") ? p.secret.slice(3) : p.secret;
  const base64 = raw.startsWith("whsec_") ? raw.slice("whsec_".length) : raw;
  const key = Buffer.from(base64, "base64");
  if (key.length === 0) throw new SignatureError("hook secret is empty or not base64");

  const expected = createHmac("sha256", key)
    .update(`${p.id}.${p.timestamp}.${p.body}`).digest("base64");

  const offered = p.signatureHeader.split(" ").map((s) => s.trim()).filter(Boolean)
    .filter((s) => s.startsWith("v1,")).map((s) => s.slice(3));
  if (offered.length === 0) throw new SignatureError("no v1 signature offered");

  const want = Buffer.from(expected);
  const ok = offered.some((c) => {
    const got = Buffer.from(c);
    return got.length === want.length && timingSafeEqual(got, want);
  });
  if (!ok) throw new SignatureError("signature does not match");
}

/* ------------------------------- the handler ----------------------------- */

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

/**
 * **Both responses carry HTTP 200. The refusal lives in the body.**
 *
 * Supabase documents the opposite — a 4xx transport status alongside an
 * `error` object — and that is not what its implementation accepts. Measured
 * against a real project with `scripts/supabase-deny-shape-probe.mts`:
 *
 *   200 + {error:{http_code,message}}   blocked, client gets 400 + our message
 *   400 + {error:{http_code,message}}   blocked, client gets an opaque
 *                                       500 "Invalid payload sent to hook" and
 *                                       the message never reaches the customer
 *   400 + {error:"string"}              same opaque 500
 *   200 + {error:"string"}              NOT BLOCKED. The user is created.
 *
 * So the transport status must be 200 and the body must carry a nested
 * `error.http_code`. The last row is the dangerous one: a near-miss shape
 * silently allows a signup the policy refused, which is why this is pinned
 * here with a test rather than left to whoever edits it next.
 *
 * A consequence worth stating: because the transport status is always 200,
 * Supabase does not retry a refusal or an outage denial. Its retry rule keys
 * on 429 and 503 transport statuses, which this can no longer return.
 */
const ALLOW = () => json({}, 200);
const DENY = (message: string, httpCode = 400) =>
  json({ error: { http_code: httpCode, message } }, 200);

/*
 * `endUserReasons` is required by `ScreeningDecision`, so a TypeScript caller
 * cannot omit it. A JavaScript one can, and the example in this repository is
 * JavaScript. Without the optional chain an incomplete `decide` return throws
 * here, in the deny path, OUTSIDE the `decide_threw` guard -- so the hook
 * rejects, and every signup fails for a reason the operator cannot see. The
 * fallback message already exists; use it rather than crash.
 */
function defaultDenyMessage(d: ScreeningDecision): string {
  return d.endUserReasons?.[0]?.message
    ?? "We could not accept those contact details. Please use a different email address.";
}

const DEFAULT_UNAVAILABLE_MESSAGE =
  "We could not complete your signup just now. Please try again in a moment.";

/** Map an HTTP status from Orisift onto an operator-meaningful reason. */
function reasonForStatus(status: number): UnavailableReason {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 402) return "insufficient_credits";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 409 || status === 422) return "invalid_request";
  return "server_error";
}

export function createBeforeUserCreatedHandler(opts: BeforeUserCreatedOptions) {
  if (!opts.apiKey) throw new Error("apiKey is required");
  if (!opts.hookSecret) {
    throw new Error("hookSecret is required: an unverified hook accepts a signup decision from anyone");
  }
  if (opts.onUnavailable !== "allow" && opts.onUnavailable !== "deny") {
    /*
     * Required at construction. A default here would decide whether your
     * product accepts people it could not screen, and that is not a decision
     * a library gets to make quietly.
     */
    throw new Error(
      'onUnavailable must be "allow" or "deny". There is no default: it decides whether an '
      + "unscreened signup proceeds when Orisift cannot answer.",
    );
  }

  const baseUrl = (opts.baseUrl ?? "https://orisift.com").replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const requested = opts.screenTimeoutMs ?? SCREENING_DEADLINE_MS;
  /*
   * Capped, not trusted. A caller asking for 9 seconds inside a 5-second
   * budget would guarantee the timeout that fails the signup.
   */
  const screenMs = Math.min(Math.max(requested, 100), SCREENING_DEADLINE_MS);

  if (!opts.dedupe?.mode) {
    throw new Error(
      'dedupe is required: {mode:"attempt"|"shared"|"single-process"|"none"}. '
      + "There is no default, because it decides how often you are charged and "
      + "how fresh your evidence is. See the identity contract in this file.",
    );
  }

  /*
   * A mode whose required parts are missing can never work, so it must not
   * construct.
   *
   * Presence of `dedupe` was already checked. Its SHAPE was not, and the gap is
   * worse than it sounds because of where the failure lands. `{mode:"attempt"}`
   * with no `attemptId` is a TypeScript error and perfectly valid JavaScript;
   * it constructed, then failed at request time into `dedupe_unavailable`, and
   * with the common `onUnavailable: "allow"` every signup was allowed with
   * nothing screened and nothing charged, returning HTTP 200 in 12ms. A
   * developer watching status codes sees working software. Measured on the
   * published 1.2.0 package while writing the integration path.
   *
   * These checks are deliberately limited to what is LOCALLY DETECTABLE: a
   * missing callback, a missing store, an unknown mode. They are facts about
   * the options object, knowable before any request. Nothing here infers
   * anything about the network, the API key or the server's opinion of a value
   * it has not seen yet.
   */
  switch (opts.dedupe.mode) {
    case "attempt":
      if (typeof (opts.dedupe as { attemptId?: unknown }).attemptId !== "function") {
        throw new Error(
          'dedupe {mode:"attempt"} requires attemptId, a function returning the attempt '
          + "identity for a payload (or null when it has none). Without it there is no "
          + "identity to deduplicate on, so every delivery would be unscreened rather "
          + "than deduplicated. Supply attemptId, or choose another mode: "
          + '"shared" (bounded, across instances), "single-process" (bounded, one process), '
          + 'or "none" (screen every delivery and be charged for it).',
        );
      }
      break;
    case "shared":
      if (!(opts.dedupe as { store?: { claim?: unknown } }).store
        || typeof (opts.dedupe as { store?: { claim?: unknown } }).store?.claim !== "function") {
        throw new Error(
          'dedupe {mode:"shared"} requires store, an AttemptKeyStore with a claim(key, '
          + "candidate, ttlMs) method. Without shared storage there is nothing to "
          + 'coordinate across instances; use "single-process" if one process is all you '
          + "have.",
        );
      }
      break;
    case "single-process":
    case "none":
      break;
    default:
      throw new Error(
        `dedupe mode "${String((opts.dedupe as { mode?: unknown }).mode)}" is not recognised. `
        + 'Valid modes: "attempt", "shared", "single-process", "none".',
      );
  }

  const dedupe = opts.dedupe;
  const windowMs = ("windowMs" in dedupe && dedupe.windowMs) || DEFAULT_DEDUPE_WINDOW_MS;

  /*
   * In-memory store for "single-process". Per handler, not module-global: two
   * handlers in one process may belong to different Orisift accounts.
   *
   * No time bucket. The entry lives for `windowMs` from the claim that made
   * it, so two deliveries a millisecond apart cannot land either side of an
   * edge, which a bucket allows and which was the flaw in the previous design.
   */
  /*
   * Last time each unavailable reason was warned about, per handler.
   *
   * Per handler rather than module-global for the same reason `local` is: two
   * handlers in one process may belong to different accounts, and one being
   * noisy must not silence the other.
   */
  const warnedAt = new Map<string, number>();

  const local = new Map<string, { value: string; expires: number }>();
  const localStore: AttemptKeyStore = {
    async claim(key, candidate, ttlMs) {
      const now = Date.now();
      const hit = local.get(key);
      if (hit && hit.expires > now) return hit.value;
      local.set(key, { value: candidate, expires: now + ttlMs });
      /* Bounded: a signup flood must not become a memory leak. */
      if (local.size > 5000) {
        for (const [k, v] of local) if (v.expires <= now) local.delete(k);
        if (local.size > 5000) local.clear();
      }
      return candidate;
    },
  };

  /*
   * The fingerprint is a keyed hash of the EXACT request body that will be
   * sent, so every field that changes the screening is in it by construction.
   * A new field cannot be added to the request and forgotten here.
   *
   * Keyed with the API key, which scopes it to the account without putting the
   * account anywhere, and means the stored key is meaningless to anyone who
   * does not already hold the key.
   *
   * **This is not anonymisation and is not offered as any.** Anyone holding
   * the API key can take a candidate address and check whether it matches a
   * stored fingerprint. It keeps addresses out of your Redis keyspace in
   * plaintext; it does not make them unrecoverable to someone with the key.
   */
  const fingerprint = (canonicalBody: string): string =>
    `orisift:supabase:${createHmac("sha256", opts.apiKey)
      .update(`${opts.integrationId ?? ""}
${canonicalBody}`)
      .digest("hex")}`;

  return async function handle(request: Request): Promise<Response> {
    const started = Date.now();
    const body = await request.text();
    const hookMessageId = request.headers.get("webhook-id") ?? "";
    /*
     * Declared here, assigned once the payload parses, because the
     * `unavailable` closure below is built before parsing and an event raised
     * on a malformed payload must still carry the fields it promises.
     */
    let idempotencyKey = "";
    let dedupeShared = false;
    let dedupeDegraded: string | null = null;

    try {
      verifySignature({
        secret: opts.hookSecret,
        id: hookMessageId,
        timestamp: request.headers.get("webhook-timestamp") ?? "",
        signatureHeader: request.headers.get("webhook-signature") ?? "",
        body,
        toleranceSeconds: opts.toleranceSeconds,
      });
    } catch {
      /* Bare 401. Naming the failing part helps forge the next one. */
      return json({ error: { http_code: 401, message: "Unauthorized" } }, 401);
    }

    let payload: BeforeUserCreatedPayload;
    try {
      payload = JSON.parse(body) as BeforeUserCreatedPayload;
    } catch {
      return DENY("Malformed hook payload.", 400);
    }
    const email = payload.user?.email?.trim();
    const phone = payload.user?.phone?.trim();
    const ip = payload.metadata?.ip_address?.trim();

    if (!email && !phone && !ip) {
      /* Nothing to screen. Allowed: refusing on absent evidence is the one
       * thing the product must not do. Not reported as screened. */
      return ALLOW();
    }

    /*
     * The request body, built ONCE and before the key, because the key is a
     * hash of it. Key order is fixed, so two deliveries that differ only in
     * property order cannot produce different fingerprints.
     */
    const requestBody = JSON.stringify({
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(ip ? { ip } : {}),
      ...(opts.policy ? { policy: opts.policy } : {}),
    });

    const unavailable = (reason: UnavailableReason, detail: string, status?: number): Response => {
      const applied = opts.onUnavailable;
      try {
        opts.onUnavailableEvent?.({
          reason, status, detail, applied,
          elapsedMs: Date.now() - started, hookMessageId, idempotencyKey,
          dedupeMode: dedupe.mode, dedupeShared, dedupeDegraded,
        });
      } catch { /* alerting must not break signup */ }

      /*
       * An allowed-but-unscreened signup must never be silent.
       *
       * Allowing it can be entirely correct: `onUnavailable: "allow"` is the
       * caller's deliberate choice to let people in when we cannot screen, and
       * this does NOT second-guess it. The response to Supabase is unchanged,
       * and success is still success.
       *
       * What was wrong is that with no `onUnavailableEvent` registered, the one
       * thing the customer bought silently did not happen: HTTP 200, empty body,
       * nothing screened, nothing charged, no trace anywhere. Measured on the
       * published package, a missing `attemptId` produced exactly that in 12ms,
       * and it is indistinguishable from a healthy screened allow.
       *
       * So when nobody is listening, say it on stderr. Once per distinct reason
       * per minute, because a flood of identical lines during an outage is how a
       * warning gets filtered out and ignored.
       *
       * Deliberately NOT in the response body: the end user is told nothing
       * operational. A signup form is not the place to disclose that a vendor is
       * unreachable or that a config value is wrong.
       */
      if (applied === "allow" && !opts.onUnavailableEvent) {
        const now = Date.now();
        const last = warnedAt.get(reason) ?? 0;
        if (now - last > 60_000) {
          warnedAt.set(reason, now);
          const where = typeof console !== "undefined" && typeof console.warn === "function"
            ? console.warn.bind(console) : null;
          where?.(
            `[orisift] SIGNUP ALLOWED WITHOUT SCREENING. reason=${reason}`
            + `${status ? ` status=${status}` : ""} detail=${detail}`
            + ` — onUnavailable is "allow", so this signup proceeded unscreened and was not`
            + ` charged. This is your configured behaviour, not a failure to act on it;`
            + ` register onUnavailableEvent to route these somewhere you watch, and this`
            + ` line will stop. Further identical warnings are suppressed for 60s.`,
          );
        }
      }

      return applied === "deny"
        ? DENY(opts.unavailableMessage ?? DEFAULT_UNAVAILABLE_MESSAGE, 503)
        : ALLOW();
    };

    /* ------------------------- which screening is this? ------------------- */

    const fresh = () => `supabase:${randomBytes(16).toString("hex")}`;

    if (dedupe.mode === "none") {
      idempotencyKey = fresh();
    } else if (dedupe.mode === "attempt") {
      let attempt: string | null = null;
      try {
        attempt = dedupe.attemptId(payload);
      } catch (err) {
        /* A throw is a failure, not a decision. Treated like a store outage:
         * nothing screened, nothing billed. */
        dedupeDegraded = `attemptId threw: ${(err as Error)?.name ?? "Error"}`;
        return unavailable("dedupe_unavailable", dedupeDegraded);
      }
      idempotencyKey = attempt
        ? `supabase:${createHmac("sha256", opts.apiKey)
            .update(`${opts.integrationId ?? ""}
attempt
${attempt}`)
            .digest("hex")
            .slice(0, 40)}`
        : fresh();
      /* Returning null is YOUR decision that this delivery has no attempt
       * identity. It is screened and billed on its own, and so are its
       * retries. The event records it so that is visible rather than assumed. */
      if (!attempt) dedupeDegraded = "no attempt id for this delivery";
    } else {
      const store = dedupe.mode === "shared" ? dedupe.store : localStore;
      const candidate = fresh();
      let claimTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        /*
         * Bounded, because a store that hangs must not spend the budget that
         * belongs to the screening. One second, or the screening deadline if
         * that is somehow shorter.
         */
        const claimed = await Promise.race([
          store.claim(fingerprint(requestBody), candidate, windowMs),
          new Promise<never>((_, reject) => {
            claimTimer = setTimeout(() => reject(new Error("claim timed out")), Math.min(1000, screenMs));
          }),
        ]);
        idempotencyKey = claimed || candidate;
        dedupeShared = idempotencyKey !== candidate;
      } catch (err) {
        dedupeDegraded = `store.claim failed: ${(err as Error)?.message ?? "error"}`;
        /*
         * The store is the only thing stopping two deliveries from buying two
         * screenings. Without it, screening anyway means every delivery is
         * billed separately, so a retry storm during a store outage multiplies
         * the bill. That is a worse failure than not screening, and a silent
         * one, so it is not the default.
         */
        const onFailure = (dedupe.mode === "shared" && dedupe.onStoreFailure) || "unavailable";
        if (onFailure === "unavailable") {
          return unavailable("dedupe_unavailable", dedupeDegraded);
        }
        idempotencyKey = candidate;
      } finally {
        clearTimeout(claimTimer);
      }
    }

    /* ------------------------- one attempt, no retry ---------------------- */

    let screening: unknown;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), screenMs);
    try {
      const res = await doFetch(`${baseUrl}/v1/signup`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        /* The same bytes the fingerprint was taken over. Building it twice is
         * how the key and the request drift apart. */
        body: requestBody,
        signal: controller.signal,
      });

      if (!res.ok) {
        /*
         * Carry the error TYPE, because the status alone is not actionable.
         *
         * Two different 409s reach an operator as `invalid_request`:
         * `idempotency_key_reused` means a key was sent for a request it did
         * not belong to, and `idempotency_key_expired` means the key is fine
         * but the screening it identified has passed its retention. The first
         * is a bug in how keys are derived; the second is answered by using a
         * new key. "HTTP 409" does not tell them which they have.
         *
         * The type only, never the message: a message is free text from the
         * far side and does not belong in a log line by default.
         */
        const body = await res.json().catch(() => null) as { error?: { type?: unknown } } | null;
        const type = typeof body?.error?.type === "string" && /^[a-z_]{1,48}$/.test(body.error.type)
          ? body.error.type
          : null;
        return unavailable(
          reasonForStatus(res.status),
          `Orisift returned HTTP ${res.status}${type ? ` (${type})` : ""}`,
          res.status,
        );
      }

      const parsed = await res.json().catch(() => null) as { object?: string } | null;
      if (!parsed || parsed.object !== "signup_screening") {
        /* 200 that is not a screening: a proxy, a captive portal, a rewritten
         * response. Treating it as a screening would be acting on nothing. */
        return unavailable("malformed_response", "200 without a signup_screening body", res.status);
      }
      screening = parsed;
    } catch (err) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      /*
       * Name the transport cause.
       *
       * Node reports every one of these as "fetch failed" and puts the real
       * reason in `cause`, so ECONNREFUSED, ECONNRESET, a TLS failure and a
       * DNS failure all arrived here as one indistinguishable string. They
       * are different operational problems with different fixes, and an
       * operator reading `unreachable` alone cannot tell which they have.
       *
       * Only the error CODE is reported, never the message, because a
       * message can carry a URL or a host that does not belong in a log
       * line a customer forwards to us.
       */
      const cause = (err as { cause?: { code?: string } })?.cause;
      const code = typeof cause?.code === "string" ? cause.code : null;
      return unavailable(
        aborted ? "timeout" : "unreachable",
        aborted
          ? `no answer within ${screenMs}ms`
          : `could not reach Orisift${code ? ` (${code})` : ""}`,
      );
    } finally {
      clearTimeout(timer);
    }

    /* ------------------------------ decide -------------------------------- */

    let decision: ScreeningDecision;
    try {
      decision = opts.decide(screening);
    } catch (err) {
      /* Your mapping is incomplete. That is not the signing-up customer's
       * fault, so it is an availability failure rather than a refusal. */
      return unavailable("decide_threw", `decide() threw: ${(err as Error)?.name ?? "Error"}`);
    }

    const u = (screening as { usage?: { credits?: number }; id?: string }) ?? {};
    try {
      opts.onDecision?.({
        decision,
        screened: true,
        creditsCharged: u.usage?.credits ?? 0,
        screeningId: u.id ?? null,
        elapsedMs: Date.now() - started,
        hookMessageId,
        idempotencyKey,
        dedupeMode: dedupe.mode,
        dedupeShared,
        dedupeDegraded,
      });
    } catch { /* logging must not break signup */ }

    if (opts.denyOn.includes(decision.enforcement)) {
      /* End-user reasons only. A caller reason is the integration's to fix and
       * would be nonsense on a signup form. */
      return DENY((opts.denyMessage ?? defaultDenyMessage)(decision), 400);
    }
    return ALLOW();
  };
}
