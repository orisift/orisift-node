# Releasing `@orisift/sdk`

## The shape of it

Publishing is triggered by a tag and authenticated by OIDC. There is no npm
token in this repository, in its secrets, or on anybody's laptop after the
bootstrap below is finished.

## Bootstrap, once only

Trusted publishing can only be configured for a package that already exists on
npm, so the first publish is the one exception and uses a token. The order
matters: a token created before it is needed is a credential sitting around for
no reason.

1. The npm organisation `orisift` exists, on the free "unlimited public
   packages" plan, and the account that owns it has authenticator-app 2FA set
   to "Authorization and writes".
2. This repository, `orisift/orisift-node`, exists and is **public**. npm does
   not generate provenance for packages published from a private repository, so
   a private repository would silently produce unattested releases.
3. `.github/workflows/publish.yml` is committed on the default branch. npm's
   trusted-publisher form will not accept a workflow filename that does not
   exist yet.
4. Publish once, interactively, from a clean checkout. **No access token is
   created.** `npm login` uses a browser flow and writes a session credential to
   `~/.npmrc`; with 2FA set to "Authorization and writes", the publish itself
   then asks for a one-time code, so the file alone cannot publish.

   ```bash
   npm login                   # browser flow, then the 2FA challenge
   npm whoami                  # confirm the account before anything is sent
   npm ci --ignore-scripts
   npm run build
   npm pack --dry-run          # read the file list before it is permanent
   npm publish                 # prompts for the one-time code
   npm logout                  # invalidates the session credential
   ```

   This is preferred over a granular access token for the bootstrap, because a
   granular token has to be generated, copied somewhere, used, and then
   remembered about. A login session is removed by the next command. Afterwards,
   check `npm token list` shows nothing you did not expect.

6. Configure the trusted publisher: npmjs.com → the package → Settings →
   Trusted Publisher → GitHub Actions. Every field is case-sensitive.

   | Field | Value |
   |---|---|
   | Organization or user | `orisift` |
   | Repository | `orisift-node` |
   | Workflow filename | `publish.yml` |
   | Environment name | blank, or `npm-publish` for a manual approval gate |

7. **Confirm no credential survived.** `npm logout` in step 4 ends the session.
   Run `npm token list` and expect nothing from this exercise. If a granular
   token was used instead of the interactive flow, delete it now: the difference
   between a credential that existed for an hour and one that exists until
   somebody remembers it is whether this step was done.

## Every release after that

```bash
# 1. Decide the version, and say why in the changelog entry.
npm version patch        # or minor, or major
# 2. Push the commit and the tag it created.
git push --follow-tags
```

The workflow then builds, checks that the tag and `package.json` agree, refuses
to republish a version that already exists, prints the file list, and publishes
with provenance. Nothing is published if any of those fail.

## Versioning

Semver, against the **published surface**: the `Orisift` class, its two methods
and their parameters, the exported types, the error classes and `SDK_VERSION`.

- **patch** — a fix that changes no signature and no documented behaviour.
- **minor** — a new optional parameter, a new export, a new error class, or a
  new member of a union that a caller can only meet by opting in.
- **major** — a removed or renamed export, a narrowed parameter, a changed
  default, or a **new member of a union a caller already switches on**.

That last case is the one that catches people. Adding an action type is a
breaking change for anybody whose `switch` is exhaustive, which is the way this
SDK tells them to write it. The SDK already refuses an unrecognised action
rather than falling through, so the failure is loud, but the version number has
to say so too.

`SDK_VERSION` is sent as `X-Orisift-Client` on every request and is asserted
against `package.json` by a test, because a mismatch makes usage data wrong in a
way nobody would notice.

## Server changes that reach the SDK

A new reason code is a **minor** release: `ReasonCode` is a literal union, so a
code the SDK does not know is a type error at the customer's build rather than
a silent string. Adding one is not urgent, but leaving it out means a customer
cannot name the code in their own `switch`.

A new capability `state` or a new `ActionType` is a **major** release, for the
reason above.

## What must never ship

Checked by `tests/sdk-package.test.ts` in the Orisift repository rather than
left to review: no staging host, no private path, no internal tooling name, the
default base URL is production, the licence file is present, and the only
published paths are `dist`, `README.md` and `LICENSE`.
