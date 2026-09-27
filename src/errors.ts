/**
 * Errors are about the call. Results are about the identifier.
 *
 * `validate()` resolves for every lookup outcome, including `rejected` and
 * `ask_to_correct`. Those are answers, and an answer you did not want is not a
 * failure. It rejects only when no usable answer was obtained.
 *
 * Two consequences worth being explicit about:
 *
 *   A capability Orisift does not offer is never an error. It arrives as
 *   `action.not_established` in a successful response.
 *
 *   Evidence that could not be gathered this time is never an error either. It
 *   arrives as `action.type === "retry_later"`.
 *
 * So you never have to interpret an exception to learn something about an
 * identifier. An exception means Orisift did not answer.
 */

export abstract class OrisiftError extends Error {
  /** From the x-request-id header. Quote it when asking for help. */
  readonly requestId: string | null;
  readonly status: number | null;
  /** The server's error type, where the server produced one. */
  readonly code: string | null;

  protected constructor(
    message: string,
    opts: { requestId?: string | null; status?: number | null; code?: string | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.requestId = opts.requestId ?? null;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
  }
}

/** No API key, or one that is obviously not a key. Thrown before any request. */
export class OrisiftConfigError extends OrisiftError {
  constructor(message: string) { super(message); }
}

/**
 * Constructed somewhere that looks like a browser.
 *
 * An Orisift key is a bearer credential for your whole account. Anything a
 * browser can read, a visitor can read, so the client refuses to exist there
 * rather than leaving it to a code review to notice.
 */
export class OrisiftBrowserError extends OrisiftError {
  constructor() {
    super(
      "The Orisift SDK is server-only. An API key in browser code is readable by anyone who opens the page. " +
      "Call Orisift from a route handler, server action or backend service, and never expose the key to the client.",
    );
  }
}

export class OrisiftAuthError extends OrisiftError {
  constructor(m: string, o: ConstructorParameters<typeof OrisiftErrorPublic>[1]) { super(m, o); }
}

export class OrisiftInvalidRequestError extends OrisiftError {
  /** Which field the server objected to, where it said. */
  readonly param: string | null;
  constructor(m: string, o: { requestId?: string | null; status?: number | null; code?: string | null; param?: string | null }) {
    super(m, o);
    this.param = o.param ?? null;
  }
}

export class OrisiftUnrecognisedInputError extends OrisiftError {
  constructor(m: string, o: ConstructorParameters<typeof OrisiftErrorPublic>[1]) { super(m, o); }
}

export class OrisiftInsufficientCreditsError extends OrisiftError {
  readonly balance: number | null;
  readonly required: number | null;
  constructor(m: string, o: { requestId?: string | null; status?: number | null; code?: string | null; balance?: number | null; required?: number | null }) {
    super(m, o);
    this.balance = o.balance ?? null;
    this.required = o.required ?? null;
  }
}

export class OrisiftRateLimitError extends OrisiftError {
  readonly retryAfterSeconds: number | null;
  constructor(m: string, o: { requestId?: string | null; status?: number | null; code?: string | null; retryAfterSeconds?: number | null }) {
    super(m, o);
    this.retryAfterSeconds = o.retryAfterSeconds ?? null;
  }
}

/**
 * The key was already used for a different request.
 *
 * Not retryable, and deliberately so. The fix is a new key, because the point
 * of the conflict is that Orisift will not guess which request you meant.
 */
export class OrisiftIdempotencyConflictError extends OrisiftError {
  constructor(m: string, o: ConstructorParameters<typeof OrisiftErrorPublic>[1]) { super(m, o); }
}

/**
 * The server answered, and the action is absent or unusable.
 *
 * This exists so that a missing action can never be read as permission to
 * proceed. If deciding fails server-side the response arrives without an
 * action rather than with a fabricated one, and the alternative here would be
 * for the SDK to quietly substitute `continue`, which is the single failure
 * mode an integrator has no way to detect.
 *
 * An action type the SDK does not recognise is treated the same way. A client
 * built against today's vocabulary must not silently mishandle an action added
 * later.
 */
export class OrisiftMalformedActionError extends OrisiftError {
  readonly received: unknown;
  constructor(m: string, o: { requestId?: string | null; status?: number | null; received?: unknown }) {
    super(m, o);
    this.received = o.received ?? null;
  }
}

export class OrisiftServerError extends OrisiftError {
  constructor(m: string, o: ConstructorParameters<typeof OrisiftErrorPublic>[1]) { super(m, o); }
}

/** No response within the configured budget. */
export class OrisiftTimeoutError extends OrisiftError {
  constructor(m: string, o: { requestId?: string | null; cause?: unknown } = {}) { super(m, o); }
}

/** DNS, TCP or TLS failure. Orisift was never reached. */
export class OrisiftConnectionError extends OrisiftError {
  constructor(m: string, o: { cause?: unknown } = {}) { super(m, o); }
}

/** The caller's AbortSignal fired. Not a failure, and never retried. */
export class OrisiftAbortedError extends OrisiftError {
  constructor() { super("The request was aborted by the caller."); }
}

/* Internal: a shape reference so the option bags above stay in step. */
declare class OrisiftErrorPublic {
  constructor(message: string, opts: {
    requestId?: string | null; status?: number | null; code?: string | null; cause?: unknown;
  });
}
