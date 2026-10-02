/**
 * SHIPPED COPY of the enforcement helper.
 *
 * The canonical implementation is `src/lib/screening/enforcement.ts` in the
 * Orisift application. This is a byte-for-byte copy of its body so that
 * customers get the same logic the product's own demonstration page runs,
 * rather than a summary of it in a guide.
 *
 * `tests/sdk-enforcement-parity.test.ts` holds the two in step across a matrix
 * of inputs. Two copies is a cost; the alternative was a guide telling every
 * customer to reimplement a decision table by hand, which is a larger one.
 * When the app consumes the published package this copy becomes the only one.
 */

/**
 * Turning a screening into a signup decision — in the customer's application.
 *
 * Orisift recommends. It does not enforce, and this module is built so that it
 * cannot start to by accident.
 *
 * There is no default mapping. A caller must state what each recommended
 * action means in their product, because the right answer is not a property of
 * the evidence: a bank and a newsletter should do different things with the
 * same `review`, and shipping a default would quietly make that decision for
 * both of them. An unmapped action is a thrown error, never a silent `allow`
 * and never a silent `block`.
 *
 * Two failure modes are handled explicitly rather than left to the caller to
 * remember:
 *
 *   Orisift did not answer. A screening that errored, timed out or was refused
 *   must not stop a signup by default — an outage on our side becoming a
 *   customer's outage is worse than the risk it was meant to catch. The caller
 *   states `onUnavailable` and it is required, so the choice is made in
 *   daylight.
 *
 *   No action was returned. That happens when no `policy` was named, and it
 *   means Orisift was not asked to recommend anything. It is not a quiet
 *   `continue`.
 */

import type { ActionType } from "./types.js";

/**
 * What the application does. Orisift never picks one of these.
 *
 * `fix_request` is the outcome for a finding the INTEGRATION has to correct:
 * a missing `country`, an unknown policy version, a malformed call. It is
 * neither accepting nor rejecting the person, because nothing was established
 * about them. The signup is held while the caller corrects the request and
 * asks again.
 *
 * It exists because the alternative was wrong in both directions. Mapping
 * `ask_to_correct` to `challenge` puts a verification step in front of a
 * customer over a field the integrator forgot; mapping it to `allow` accepts
 * someone on the strength of a check that never ran.
 */
export type Enforcement = "allow" | "challenge" | "review_queue" | "block" | "fix_request";

export interface EnforcementPolicy {
  /** Every action the aggregation policy can return must be mapped. */
  map: Record<ActionType, Enforcement>;
  /**
   * Used whenever the recommended action is addressed to the CALLER, whatever
   * `map` says for that action type.
   *
   * Required, not optional with a default, because the founder's browser
   * review found the consequence of leaving it to `map`: a caller-correction
   * screening rendered "Enforcement: challenge" directly above "show the
   * person signing up: nothing". The label and the branch disagreed, and the
   * branch was the wrong one.
   *
   * The same action type means two different things depending on audience, so
   * one entry in `map` cannot serve both.
   */
  onCallerActionable: Enforcement;
  /** Orisift errored, timed out, refused the request or was unreachable. */
  onUnavailable: Enforcement;
  /** A screening ran but recommended nothing, because no policy was named. */
  onNoRecommendation: Enforcement;
}

export interface ScreeningLike {
  id?: string;
  recommended_action?: {
    type: ActionType;
    audience: "caller" | "end_user";
    reasons: Array<{ input: string; code: string; audience: "caller" | "end_user"; message: string }>;
    does_not_resolve?: string[];
  } | null;
  usage?: { billed: boolean; credits: number };
}

export interface SignupDecision {
  enforcement: Enforcement;
  /** Why, in terms the application can log. Never shown to an end user as-is. */
  basis: "recommended_action" | "no_recommendation" | "screening_unavailable";
  action: ActionType | null;
  /**
   * Who the action is addressed to. Carried out of the response because the
   * same action type means two different things depending on it, and the
   * staging demonstration is what surfaced this: a screening whose phone
   * lacked a `country` returns `ask_to_correct` with `audience: "caller"`, and
   * an enforcement map that sends `ask_to_correct` to `challenge` would then
   * challenge the person signing up over a field the INTEGRATOR omitted. There
   * is nothing to show them, and `endUserReasons` is correctly empty.
   *
   * `callerActionable` is the flag to branch on: when it is true, fix the
   * request and retry rather than putting anything in front of the end user.
   */
  audience: "caller" | "end_user" | null;
  /** True when this action is the caller's to resolve, not the end user's. */
  callerActionable: boolean;
  screeningId: string | null;
  /**
   * Reasons safe to render to the person signing up: `audience: "end_user"`
   * only. A caller reason such as "supply `country`" is an instruction to the
   * integrator and would be nonsense on a signup form.
   */
  endUserReasons: Array<{ input: string; code: string; message: string }>;
  /** Reasons for the integrator's logs and dashboards. */
  callerReasons: Array<{ input: string; code: string; message: string }>;
  /** Findings this decision does not settle, carried through so they are not lost. */
  stillOutstanding: string[];
}

export class UnmappedAction extends Error {
  constructor(action: string) {
    super(
      `No enforcement is mapped for the recommended action "${action}". `
      + "Add it to your enforcement policy. Orisift will not choose on your behalf, "
      + "because allowing and blocking are both wrong answers to guess at.",
    );
    this.name = "UnmappedAction";
  }
}

/**
 * Decide, from a `/v1/signup` response the application already has.
 *
 * Pure: no network, no clock, no storage. The same response and the same
 * policy always produce the same decision, so it can be unit-tested in the
 * customer's own suite and replayed against a stored screening later.
 */
export function decideSignup(
  screening: ScreeningLike | null,
  policy: EnforcementPolicy,
): SignupDecision {
  const empty = {
    endUserReasons: [], callerReasons: [], stillOutstanding: [],
    audience: null, callerActionable: false,
  };

  /* Orisift did not answer. The caller decided in advance what that means. */
  if (!screening) {
    return { enforcement: policy.onUnavailable, basis: "screening_unavailable", action: null, screeningId: null, ...empty };
  }

  const action = screening.recommended_action;
  if (!action) {
    return {
      enforcement: policy.onNoRecommendation, basis: "no_recommendation",
      action: null, screeningId: screening.id ?? null, ...empty,
    };
  }

  /*
   * Audience decides first.
   *
   * A caller-addressed action is the integration's to fix; `map` describes
   * what to do about the person, and there is nothing to do about the person
   * here. Resolving `map` first and then correcting for audience would leave
   * the wrong value reachable, so audience is resolved first and `map` is not
   * consulted at all in that branch.
   */
  const callerActionable = action.audience === "caller";
  const enforcement = callerActionable ? policy.onCallerActionable : policy.map[action.type];
  if (!enforcement) throw new UnmappedAction(action.type);

  const reasons = action.reasons ?? [];
  return {
    enforcement,
    basis: "recommended_action",
    action: action.type,
    audience: action.audience,
    callerActionable,
    screeningId: screening.id ?? null,
    endUserReasons: reasons.filter((r) => r.audience === "end_user")
      .map((r) => ({ input: r.input, code: r.code, message: r.message })),
    callerReasons: reasons.filter((r) => r.audience === "caller")
      .map((r) => ({ input: r.input, code: r.code, message: r.message })),
    stillOutstanding: action.does_not_resolve ?? [],
  };
}

/**
 * A starting point, not a default.
 *
 * Exported so an integrator has something concrete to copy and change, and
 * deliberately NOT used anywhere by `decideSignup`. Importing it is a decision
 * that shows up in a diff; a default would not.
 *
 * It is cautious in one direction only: nothing here blocks a signup outright,
 * because a wrong block turns a real customer away and nothing in a contact
 * check is strong enough evidence to justify that on its own.
 */
export const EXAMPLE_ENFORCEMENT: EnforcementPolicy = {
  map: {
    continue: "allow",
    ask_to_correct: "challenge",
    verify_contact: "challenge",
    review: "review_queue",
    retry_later: "allow",
  },
  /*
   * Neither challenging the person nor accepting them. The request was
   * incomplete; fix it and ask again.
   */
  onCallerActionable: "fix_request",
  onUnavailable: "allow",
  onNoRecommendation: "allow",
};

/**
 * One line of guidance per outcome, for a user interface to render.
 *
 * `fix_request` says to fix the request, not merely to use a new key. A new
 * idempotency key is required for a changed request and does not supply a
 * missing country, and the earlier wording implied it did.
 */
export const ENFORCEMENT_GUIDANCE: Record<Enforcement, string> = {
  allow: "Continue the signup.",
  challenge: "Confirm the contact through a channel Orisift did not use before relying on it.",
  review_queue: "Let the signup proceed and put it in front of a person.",
  block: "Refuse the signup.",
  fix_request: "Fix the request, then retry with a new idempotency key.",
};
