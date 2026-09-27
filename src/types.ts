/**
 * The wire contract, in TypeScript.
 *
 * These names mirror what /v1/lookup actually returns, in the same snake_case,
 * so a response can be compared against them field by field without a mental
 * translation step.
 */

export type IdentifierType = "phone" | "email" | "ip" | "domain";

/** Unchanged from v1. `verified` means no blocking evidence, not "confirmed". */
export type Verdict = "verified" | "risky" | "rejected" | "insufficient_evidence";

export type ActionType =
  | "continue"
  | "ask_to_correct"
  | "verify_contact"
  | "review"
  | "retry_later";

export type ReasonClass =
  | "request_context"
  | "conclusive_negative"
  | "evidence_gap"
  | "capability_gap"
  | "advisory";

export type PolicyId = "contact_standard";

/**
 * Every reason code the catalogue publishes.
 *
 * A literal union rather than `string`, so autocomplete lists them and a typo
 * is a compile error rather than a branch that silently never runs.
 */
export type ReasonCode =
  | "country_required" | "unknown_country"
  | "phone_unparseable" | "phone_not_possible" | "phone_plan_mismatch"
  | "phone_reserved_range" | "phone_premium_rate"
  | "email_syntax_invalid" | "email_localpart_too_long" | "email_domain_unusable"
  | "email_null_mx" | "email_domain_nxdomain" | "email_no_mail_routing"
  | "email_routing_undetermined" | "email_disposable_listed" | "email_role_mailbox"
  | "email_alias_relay" | "email_forwarding_mx" | "email_mixed_script_domain"
  | "email_free_provider"
  | "domain_syntax_invalid" | "domain_nxdomain" | "domain_dns_unavailable"
  | "ip_syntax_invalid" | "ip_special_purpose_range" | "ip_hosting_inferred"
  | "dns_inconclusive" | "rdns_inconclusive" | "line_type_unknown"
  | "no_carrier_provider" | "no_mailbox_verification" | "no_registration_data"
  | "no_threat_intelligence" | "smtputf8_local_part";

export interface Reason {
  code: ReasonCode;
  class: ReasonClass;
  /**
   * Who can put it right. `caller` means your integration sent an incomplete
   * request, so showing the person a field error would blame the wrong party.
   * Null where nothing is wrong to begin with.
   */
  correctable_by: "end_user" | "caller" | null;
  /** RFC 6901 JSON Pointer into this same response. */
  evidence: string;
  /**
   * Orisift's wording for the finding. May quote part of the submitted value,
   * so it is treated as customer data and is never passed to a logging hook.
   */
  message: string;
}

export interface Action {
  type: ActionType;
  policy: PolicyId;
  policy_version: number;
  reasons: Reason[];
  /**
   * Capabilities Orisift does not offer, listed so you can see what was not
   * checked. Always present for a given identifier type, so nothing here
   * counted against this particular value.
   */
  not_established: ReasonCode[];
  /** Present only on retry_later. A constant hint, not a measurement. */
  retry_after_seconds?: number;
}

export interface Signal {
  label: string;
  value: string;
  tone: "good" | "warn" | "bad" | "neutral" | "unknown";
  source: string;
  provenance: string;
}

export interface Capability {
  id: "syntax" | "plan_validity" | "infrastructure" | "reputation" | "carrier" | "reachability";
  /**
   * `unsupported` means Orisift does not currently offer this, so retrying
   * will not help while that stays true. `unavailable` means it was offered
   * and could not be obtained this time. Confusing the two is the single most
   * common integration error, which is why they are different words.
   */
  state: "verified" | "failed" | "inferred" | "unsupported" | "unavailable";
  detail: string;
}

export interface LookupResponse {
  object: "lookup";
  api_version: string;
  id: string;
  created: string;
  type: IdentifierType;
  country: string | null;
  normalized: string;
  verdict: Verdict;
  /** Null when the verdict is insufficient_evidence. Nothing is scored blind. */
  risk_score: number | null;
  evidence_coverage: number;
  headline: string;
  summary: string;
  recommendation: string;
  attributes: Array<{ label: string; value: string; observed: boolean }>;
  signals: Signal[];
  capabilities: Capability[];
  coverage_limitations: Array<{ code: string; message: string }>;
  analysis: { checks: string[]; ai: string; model: string | null };
  usage: {
    credits: number;
    credit_cost_table: Record<IdentifierType, number>;
    balance: number;
    idempotent_replay: boolean;
  };
  latency_ms: number;
  /** Present only when a policy was named. */
  action?: Action;
}

/** What validate() resolves to: a LookupResponse whose action is guaranteed. */
export type ValidatedResponse = LookupResponse & { action: Action };
