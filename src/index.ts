import { parseRetryAfter } from "./retry-after.js";
import {
  OrisiftAbortedError, OrisiftAuthError, OrisiftBrowserError, OrisiftConfigError,
  OrisiftConnectionError, OrisiftError, OrisiftIdempotencyConflictError,
  OrisiftInsufficientCreditsError, OrisiftInvalidRequestError,
  OrisiftMalformedActionError, OrisiftRateLimitError, OrisiftServerError,
  OrisiftTimeoutError, OrisiftUnrecognisedInputError,
} from "./errors.js";
import type {
  Action, ActionType, IdentifierType, LookupResponse, PolicyId, ReasonCode,
  ValidatedResponse,
} from "./types.js";

export * from "./types.js";
export * from "./errors.js";

/** Sent as X-Orisift-Client so deprecations can be planned against real usage. */
export const SDK_VERSION = "1.2.0";

const DEFAULT_BASE_URL = "https://orisift.com";

/**
 * Every action this SDK version understands.
 *
 * An action outside this set is treated as malformed rather than ignored. A
 * client built against today's vocabulary must not silently mishandle one
 * added later, and "I do not recognise this" is a better outcome than a
 * default branch quietly taken.
 */
const KNOWN_ACTIONS: readonly string[] = [
  "continue", "ask_to_correct", "verify_contact", "review", "retry_later",
];

/* ------------------------------- logging -------------------------------- */

/**
 * What a logging hook is given, and nothing else.
 *
 * `input` is absent. So is `normalized`, so is every reason `message`, so is
 * the response body. The value never reaches the callback, which means a
 * customer cannot accidentally log an identifier through the SDK's own
 * observability surface even if they log the entire argument.
 *
 * Reason *codes* are here because they are Orisift's closed vocabulary and
 * describe Orisift's evidence, not the customer's data. Reason *messages* are
 * not, because they can quote part of the submitted value.
 */
export interface RequestEvent {
  requestId: string | null;
  type?: IdentifierType;
  policy?: PolicyId;
  policyVersion?: number;
  attempt: number;
}

export interface ResponseEvent {
  requestId: string | null;
  status: number;
  latencyMs: number;
  attempt: number;
  action?: ActionType;
  reasonCodes?: ReasonCode[];
  policyVersion?: number;
}

export interface OrisiftOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per attempt, not per call. Default 10000. */
  timeoutMs?: number;
  /** Transport retries only. Default 2. */
  maxRetries?: number;
  /**
   * Total wall time across every attempt including backoff. Default 30000.
   *
   * Separate from timeoutMs because three attempts at ten seconds plus backoff
   * is most of a minute, and a caller holding an HTTP request open needs a
   * bound on the whole thing rather than on each part of it.
   */
  maxTotalMs?: number;
  onRequest?: (event: RequestEvent) => void;
  onResponse?: (event: ResponseEvent) => void;
  /** Test seam. Not part of the supported surface. */
  fetch?: typeof globalThis.fetch;
}

export interface ValidateParams {
  input: string;
  policy: PolicyId;
  policyVersion?: number;
  type?: IdentifierType;
  country?: string;
  retainInput?: boolean;
  explain?: boolean;
  /**
   * Generated per call when omitted, so an automatic transport retry is safe
   * by default.
   *
   * Supply your own to make a user-visible operation idempotent, for example
   * against a double-clicked form. Two different requests must never share a
   * key: that is a 409, not a replay.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export type LookupParams = Omit<ValidateParams, "policy" | "policyVersion">;

/* ------------------------------- client --------------------------------- */

function looksLikeBrowser(): boolean {
  return typeof (globalThis as { window?: unknown }).window !== "undefined"
    && typeof (globalThis as { document?: unknown }).document !== "undefined";
}

/** Retryable transport conditions. Nothing else, and never a 4xx but 429. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class Orisift {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #maxTotalMs: number;
  readonly #onRequest?: (e: RequestEvent) => void;
  readonly #onResponse?: (e: ResponseEvent) => void;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OrisiftOptions) {
    if (looksLikeBrowser()) throw new OrisiftBrowserError();

    if (!options?.apiKey || typeof options.apiKey !== "string" || !options.apiKey.trim()) {
      throw new OrisiftConfigError(
        "An API key is required. Pass { apiKey: process.env.ORISIFT_API_KEY } and keep the value server-side.",
      );
    }

    this.#apiKey = options.apiKey.trim();
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#maxTotalMs = options.maxTotalMs ?? 30_000;
    this.#onRequest = options.onRequest;
    this.#onResponse = options.onResponse;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * Validate an identifier and get a suggested next action.
   *
   * The returned `action` is guaranteed: if the server does not supply a
   * usable one this throws OrisiftMalformedActionError rather than inferring
   * anything. `continue` is never assumed.
   */
  async validate(params: ValidateParams): Promise<ValidatedResponse> {
    const body = this.#body(params);
    body.policy = params.policy;
    if (params.policyVersion !== undefined) body.policy_version = params.policyVersion;

    const response = await this.#send(body, params);
    const action = response.action;

    if (!action || typeof action !== "object") {
      throw new OrisiftMalformedActionError(
        "The response carried no action although a policy was requested. Orisift omits the action when it " +
        "cannot decide one, rather than guessing. Treat this as an error, not as permission to proceed.",
        { requestId: response.id ?? null, status: 200, received: action },
      );
    }
    if (!KNOWN_ACTIONS.includes(action.type)) {
      throw new OrisiftMalformedActionError(
        `Unrecognised action type "${action.type}". This SDK version understands: ${KNOWN_ACTIONS.join(", ")}. ` +
        "Upgrade @orisift/sdk rather than handling it as a default.",
        { requestId: response.id ?? null, status: 200, received: action.type },
      );
    }
    if (typeof action.policy_version !== "number" || !Array.isArray(action.reasons)) {
      throw new OrisiftMalformedActionError(
        "The action is missing policy_version or reasons and cannot be acted on.",
        { requestId: response.id ?? null, status: 200, received: action },
      );
    }

    return response as ValidatedResponse;
  }

  /**
   * Evidence only, with no policy and no action. Matches the contract as it
   * was before the action layer, for callers who apply their own rules.
   */
  async lookup(params: LookupParams): Promise<LookupResponse> {
    return this.#send(this.#body(params), params);
  }

  #body(p: ValidateParams | LookupParams): Record<string, unknown> {
    const body: Record<string, unknown> = { input: p.input };
    if (p.type) body.type = p.type;
    if (p.country) body.country = p.country.toUpperCase();
    if (p.retainInput) body.retain_input = true;
    if (p.explain) body.explain = true;
    return body;
  }

  async #send(
    body: Record<string, unknown>,
    params: { idempotencyKey?: string; signal?: AbortSignal; type?: IdentifierType; policy?: PolicyId; policyVersion?: number },
  ): Promise<LookupResponse> {
    /*
     * One key for the whole call, reused by every transport retry. That reuse
     * is what makes automatic retry safe: a retried attempt is the same
     * request, so it replays rather than billing again.
     */
    const idempotencyKey = params.idempotencyKey ?? crypto.randomUUID();
    const deadline = Date.now() + this.#maxTotalMs;

    let lastError: OrisiftError | null = null;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (params.signal?.aborted) throw new OrisiftAbortedError();
      if (Date.now() >= deadline) {
        throw lastError ?? new OrisiftTimeoutError(
          `Gave up after ${this.#maxTotalMs}ms across ${attempt} attempt(s).`,
        );
      }

      this.#onRequest?.({
        requestId: null, attempt,
        type: params.type, policy: params.policy, policyVersion: params.policyVersion,
      });

      const started = Date.now();
      let res: Response;

      /* Whichever comes first: the per-attempt timeout, the remaining total
       * budget, or the caller's own signal. */
      const remaining = Math.max(1, Math.min(this.#timeoutMs, deadline - Date.now()));
      const timer = AbortSignal.timeout(remaining);
      const signal = params.signal
        ? AbortSignal.any([timer, params.signal])
        : timer;

      try {
        res = await this.#fetch(`${this.#baseUrl}/v1/lookup`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.#apiKey}`,
            "idempotency-key": idempotencyKey,
            "x-orisift-client": `@orisift/sdk/${SDK_VERSION}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (params.signal?.aborted) throw new OrisiftAbortedError();
        const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
        lastError = timedOut
          ? new OrisiftTimeoutError(`No response within ${remaining}ms.`, { cause: err })
          : new OrisiftConnectionError("Could not reach Orisift.", { cause: err });
        if (attempt < this.#maxRetries) {
          await this.#backoff(attempt, null, deadline, params.signal);
          continue;
        }
        throw lastError;
      }

      const requestId = res.headers.get("x-request-id");
      const payload = await res.json().catch(() => null) as Record<string, unknown> | null;

      this.#onResponse?.({
        requestId, status: res.status, latencyMs: Date.now() - started, attempt,
        action: (payload?.action as Action | undefined)?.type,
        reasonCodes: (payload?.action as Action | undefined)?.reasons?.map((r) => r.code),
        policyVersion: (payload?.action as Action | undefined)?.policy_version,
      });

      if (res.ok) return payload as unknown as LookupResponse;

      const error = toError(res.status, requestId, payload, retryAfterSeconds(res));

      /*
       * A 200 carrying retry_later is NOT retried here. That is an application
       * decision about evidence, not a transport failure, and a later recheck
       * is a new lookup: it needs a new idempotency key and costs another
       * credit. Retrying it automatically would bill for the same incomplete
       * answer twice.
       */
      if (RETRYABLE_STATUS.has(res.status) && attempt < this.#maxRetries
          && this.#canHonour(retryAfterSeconds(res), deadline)) {
        lastError = error;
        await this.#backoff(attempt, retryAfterSeconds(res), deadline, params.signal);
        continue;
      }
      throw error;
    }

    throw lastError ?? new OrisiftTimeoutError("Exhausted every attempt without a response.");
  }

  /**
   * Whether a `Retry-After` can be honoured inside this request's deadline.
   *
   * A server may legitimately ask for a delay longer than the caller is
   * willing to wait. Orisift's daily unbilled ceiling does exactly that: it
   * clears at 00:00 UTC, so `Retry-After` can be tens of thousands of seconds.
   *
   * Without this check the client sleeps `min(delay, time left)` and then
   * finds the deadline spent, so a refusal it could have reported in under a
   * second instead blocks for the whole budget, 30 seconds by default. The
   * wait never produces a successful retry, because an attempt issued at the
   * deadline has no time left to run. It is pure latency.
   *
   * Returning false here surfaces the error straight away. `retryAfterSeconds`
   * is still on it, so a caller can schedule properly instead of guessing.
   * Short delays are unaffected: an ordinary `rate_limited` asking for two
   * seconds still retries exactly as before.
   */
  #canHonour(retryAfter: number | null, deadline: number): boolean {
    if (retryAfter === null) return true;
    return retryAfter * 1000 <= Math.max(0, deadline - Date.now());
  }

  async #backoff(attempt: number, retryAfter: number | null, deadline: number, signal?: AbortSignal) {
    /* Full jitter, so a fleet of retrying clients does not arrive together. */
    const base = retryAfter !== null ? retryAfter * 1000 : 2 ** attempt * 250;
    const wait = Math.min(Math.random() * base + base / 2, Math.max(0, deadline - Date.now()));
    if (wait <= 0) return;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new OrisiftAbortedError());
      }, { once: true });
    });
  }
}

/** The `Retry-After` header on this response, in seconds, or null. */
function retryAfterSeconds(res: Response): number | null {
  return parseRetryAfter(res.headers.get("retry-after"));
}

function toError(
  status: number,
  requestId: string | null,
  payload: Record<string, unknown> | null,
  retryAfter: number | null = null,
): OrisiftError {
  const error = (payload?.error ?? {}) as Record<string, unknown>;
  const message = typeof error.message === "string" ? error.message : `Orisift returned HTTP ${status}.`;
  const code = typeof error.type === "string" ? error.type : null;
  const base = { requestId, status, code };

  switch (status) {
    case 400: return new OrisiftInvalidRequestError(message, { ...base, param: typeof error.param === "string" ? error.param : null });
    case 401: return new OrisiftAuthError(message, base);
    case 402: return new OrisiftInsufficientCreditsError(message, {
      ...base,
      balance: typeof error.balance === "number" ? error.balance : null,
      required: typeof error.required === "number" ? error.required : null,
    });
    case 409: return new OrisiftIdempotencyConflictError(message, base);
    case 422: return new OrisiftUnrecognisedInputError(message, base);
    case 429: return new OrisiftRateLimitError(message, {
      ...base,
      /*
       * Body first, then the header.
       *
       * Orisift's own 429 carries `retry_after` in the JSON body and repeats it
       * in the header, so either source works against this API. A 429 from
       * anywhere else in the path, a CDN or an edge limiter, sends the header
       * and a body that is not our JSON at all, and the body-only read then
       * reported null while the server had plainly said how long to wait.
       *
       * The header is already parsed for backoff; this makes the same value
       * visible to a caller inspecting the error. Still null when the server
       * provided nothing, because a number invented here would be indis-
       * tinguishable from one the service actually asked for.
       */
      retryAfterSeconds: typeof error.retry_after === "number"
        ? error.retry_after
        : retryAfter,
    });
    default:
      if (status >= 500) return new OrisiftServerError(message, base);
      return new OrisiftInvalidRequestError(message, { ...base, param: null });
  }
}
