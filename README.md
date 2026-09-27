# @orisift/sdk

Official TypeScript SDK for Orisift. **Server-side only.**

No runtime dependencies.

**Build on Node 22 LTS or later.** That is the current supported line. The
package installs on Node 20 and later so an existing integration is not locked
out by an upgrade, but [Node 20 reached end of life in March 2026](https://nodejs.org/en/about/previous-releases)
and receives no security fixes, so it is a compatibility floor rather than a
recommendation. Continuous integration builds and exercises the package on Node 20 and Node 22, so the floor is tested rather than assumed.

Both module systems work, from the same file:

```ts
import { Orisift } from "@orisift/sdk";     // any supported Node
const { Orisift } = require("@orisift/sdk"); // Node 20.19+ or 22.12+
```

`require` needs a Node where `require(esm)` is unflagged, which is 20.19 and
22.12 onwards. `import` works on every Node this package supports. The floor in
`engines` is the lower of the two, because refusing to install for someone whose
`import` works perfectly would be the wrong trade.

## Getting a key

1. Create an account at [orisift.com/signup](https://orisift.com/signup). A new
   account starts with free credits, and no card is required to try it.
2. Create a key in the [dashboard](https://orisift.com/app). It is shown once
   and only a hash is stored, so a lost key is rotated rather than recovered.
3. Keep it server-side. Anyone holding the key can spend the account's credits.

The full API reference, including the response shape, the reason-code catalogue
and the coverage limits, is at [orisift.com/docs](https://orisift.com/docs). The
section covering this package is at
[orisift.com/docs#sdk](https://orisift.com/docs#sdk).

## Quick start

```bash
npm install @orisift/sdk
```

```ts
import { Orisift } from "@orisift/sdk";

const orisift = new Orisift({ apiKey: process.env.ORISIFT_API_KEY! });

const result = await orisift.validate({
  input: "user@example.com",
  policy: "contact_standard",
  idempotencyKey: `${submissionId}:email`,
});

switch (result.action.type) {
  case "continue":       return accept();
  case "ask_to_correct": return askToFix(result.action.reasons);
  case "verify_contact": return acceptPendingVerification();
  case "review":         return acceptAndFlag();
  case "retry_later":    return acceptAndRecheckLater();
}
```

That `switch` is exhaustive against `ActionType`. If a new action is ever added,
your code fails to compile rather than falling through silently.

## What a `continue` means, and what it does not

`continue` means Orisift did not establish a blocking structural or
infrastructural issue under the policy you chose.

It does **not** mean the person is real, the mailbox exists, the phone is
active, the contact is reachable, the message will be delivered, or the
transaction is safe. Orisift establishes structural and infrastructural
evidence. It does not establish existence, ownership or activity of any
identifier, and `action.not_established` lists what it did not check.

`verify_contact` is a prompt to run your own verification. It does not mean
Orisift verified anything.

## Branch on `action.type`, not on `verdict`

`verdict` is a human-facing summary and `verified` there means "no blocking
evidence", not the industry sense of a confirmed mailbox. The action vocabulary
has no word that can be misread that way, so use it for control flow.

The two are allowed to disagree. A listed disposable domain comes back with
`verdict: "rejected"` and `action.type: "review"`, because the disposable list
has known gaps and that is not strong enough to turn a person away.

## Errors are about the call, not the identifier

`validate()` resolves for every lookup outcome, including `rejected` and
`ask_to_correct`. Those are answers. It rejects only when no usable answer was
obtained.

| Class | When |
|---|---|
| `OrisiftConfigError` | no API key. Thrown before any request |
| `OrisiftBrowserError` | constructed in a browser |
| `OrisiftAuthError` | 401 |
| `OrisiftInvalidRequestError` | 400, with `.param` |
| `OrisiftInsufficientCreditsError` | 402, with `.balance` and `.required` |
| `OrisiftIdempotencyConflictError` | 409, key reused for a different request |
| `OrisiftUnrecognisedInputError` | 422 |
| `OrisiftRateLimitError` | 429, with `.retryAfterSeconds` |
| `OrisiftMalformedActionError` | 200, action absent or unusable |
| `OrisiftServerError` | 5xx |
| `OrisiftTimeoutError` | no response in the budget |
| `OrisiftConnectionError` | Orisift was never reached |
| `OrisiftAbortedError` | your `AbortSignal` fired |

Every error carries `requestId`. Quote it when asking for help.

**A capability Orisift does not offer is never an error.** It is
`action.not_established` in a successful response. **Evidence that could not be
gathered is never an error either.** It is `action.type === "retry_later"`. You
never have to read an exception to learn something about an identifier.

### `OrisiftMalformedActionError` deserves a note

If Orisift cannot decide an action it returns the response **without** one
rather than guessing. The SDK then throws rather than substituting `continue`,
because a fabricated green light is the one failure you have no way to detect.
An action type this SDK version does not recognise throws the same way.

Handle it as you would a 5xx: do not proceed as though the check passed.

## Retries

**Transport retries** are automatic, bounded and invisible.

| Condition | Retried |
|---|---|
| 429 | yes, honouring `Retry-After` |
| 500, 502, 503, 504 | yes, exponential backoff with full jitter |
| network error, timeout | yes |
| 400, 401, 402, 409, 422 | no |
| 200 with any action | no |

Bounded by `maxRetries` (default 2) **and** `maxTotalMs` (default 30000), which
caps total wall time including backoff. An `AbortSignal` cancels immediately,
mid-backoff included.

Every transport retry reuses the same idempotency key, which is what makes
automatic retry safe: the server replays rather than charging again.

**`retry_later` is different.** It is an application decision about evidence,
not a transport failure, and the SDK never acts on it for you.

> A later recheck is a **new lookup**. It needs a **new idempotency key** and
> **costs another credit**. Reusing the original key would replay the original
> incomplete result, and a changed request under the same key is a 409.

Queue the recheck with a backoff. Do not loop.

## Idempotency

A key is generated per call when you do not supply one, so retries are safe by
default.

Supply your own to make a user-visible operation idempotent, for example against
a double-clicked form. Two rules:

- **A retry of the same operation keeps its key.**
- **A different request gets a new key.** A corrected field is a different
  request.

Validating an email and a phone in one form submission are two different
requests and need **two different keys**:

```ts
const email = await orisift.validate({ input: form.email, policy: "contact_standard",
                                       idempotencyKey: `${submissionId}:email` });
const phone = await orisift.validate({ input: form.phone, policy: "contact_standard",
                                       idempotencyKey: `${submissionId}:phone` });
```

Reusing one key for a different request returns **409
`idempotency_key_reused`**, not a replay. Orisift will not guess which request
you meant.

## Policy versions

`policy` is required by `validate()`. `policyVersion` is optional.

- Omitted means the latest version at the time of the request. The integer it
  resolved to always comes back in `action.policy_version`, so a response never
  leaves the version ambiguous.
- Supplied pins that version.
- An unknown version is a 400 naming the supported versions. It never falls back.

Pin a version if you have written logic against a specific rule set.

## Security

**The API key is a bearer credential for your whole account. Keep it
server-side.** There is no publishable or restricted key.

The SDK refuses to construct in a browser, declares `"browser": false`, and
exports no browser condition, so a bundler resolving for the browser fails at
build time. Those are guards against a mistake, not a security boundary: the
boundary is that the key never leaves your server.

The API also refuses cross-origin preflight, which stops a page calling it
directly. **This does not protect a leaked key.** A leaked key works from curl,
a script, or any server anywhere. If a key is exposed, rotate it in the
dashboard immediately.

## Logging

Nothing is logged by default. The optional hooks receive an explicit allowlist:

```ts
new Orisift({
  apiKey: process.env.ORISIFT_API_KEY!,
  onResponse: (e) => logger.info("orisift", e),
});
```

```ts
interface ResponseEvent {
  requestId: string | null; status: number; latencyMs: number; attempt: number;
  action?: ActionType; reasonCodes?: ReasonCode[]; policyVersion?: number;
}
```

The identifier is not a field, so logging the whole event cannot leak it. Reason
**codes** are included because they describe Orisift's evidence in a closed
vocabulary. Reason **messages** are excluded because they can quote part of what
was submitted.

If you log elsewhere in your own code, do not log `input`, `normalized` or
`action.reasons[].message`.

## Compatibility

The SDK targets `api_version: "1"`. Additive response fields appear without a
version bump and the SDK ignores what it does not know. Removals or meaning
changes would ship as `/v2` and a new major version of this package.

`X-Orisift-Client` carries the SDK version on every request, so deprecations can
be planned against real usage rather than guesswork.
