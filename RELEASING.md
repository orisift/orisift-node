# Releasing `@orisift/sdk`

## The shape of it

A tag stages a release. A person makes it live.

The trusted publisher for this package has **direct publishing disabled**, so
the workflow can put a tarball into npm's staging queue and nothing else.
Promoting it requires a 2FA challenge that no CI credential can answer.

That division is the security property, not a formality. A compromised Action,
a pull request that edits the workflow file, or a stolen GitHub session can at
most leave a tarball awaiting approval. None of them can ship code to anybody
who runs `npm install`. There is no npm token in this repository, in its
secrets, or on anybody's laptop.

## Status

Trusted publishing is **proven end to end**, on `1.1.1`, 27 September 2026:

    GitHub Actions OIDC  ->  npm staging queue  ->  human 2FA approval
                         ->  publication        ->  verified provenance

No npm publishing token exists, and none was used. The provenance attestation
resolves to this repository, `.github/workflows/publish.yml`, the tag
`refs/tags/v1.1.1` and commit `6c340f9bb22852f4f229bcd2fda59fc90ff8e885`, on a
GitHub-hosted runner. `npm audit signatures` reports a verified attestation.

`1.1.0` has no provenance. It was published interactively before the trusted
publisher existed, which is the one exception described below.

## Bootstrap: done, kept for the record

**1.1.0 was published on 27 September 2026 and this section is history.** It is
left here because the sequence is not obvious and would have to be rediscovered
if the package were ever republished under a different name.

The one-time exception was that a trusted publisher can only be configured on a
package that already exists, so the first publish could not use OIDC. It used an
interactive login and a 2FA challenge rather than an access token, and the
session was ended immediately afterwards. That release carries no provenance,
because provenance is generated from a CI OIDC token and a local publish cannot
produce one. Every release staged by the workflow does carry it.

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

### What CI does

```bash
# 1. Decide the version, and say why in the changelog entry.
npm version patch        # or minor, or major
# 2. Push the commit and the tag it created.
git push --follow-tags
```

The workflow builds, checks that the tag and `package.json` agree, refuses a
version that already exists, prints the file list, and **stages** the release
with provenance. Nothing is staged if any of those fail, and nothing is live
even when they all pass.

### What you do

Staging is silent as far as users are concerned: `npm install` still gets the
previous version, and the staged tarball is visible only to maintainers. Making
it live is four commands from a terminal signed in to npm.

```bash
npm login                       # browser flow, then 2FA
npm stage list                  # what is waiting, with its stage id
npm stage view <stage-id>       # metadata for that stage, including its shasum
npm stage approve <stage-id>    # prompts for 2FA, then it is live
npm logout
```

**Check the shasum before approving.** `npm stage view` returns a metadata
summary, not the contents of the tarball: the stage id, package name, version,
dist-tag, who staged it, the shasum, the access level and the status. An earlier
version of this document said it printed the file list and told you to read it.
It does not, and that instruction could not be followed.

The `shasum` field is the check, and it is a stronger one than reading a file
list would have been. It is the SHA-1 of the exact tarball that would be
published, so comparing it against the artifact that was reviewed settles the
question of whether the bytes are the same bytes. A file list can match while the
contents differ; a hash cannot.

```bash
# In the reviewed checkout, from the tarball the release was approved on:
npm pack
sha1sum orisift-sdk-<version>.tgz     # must equal the shasum npm shows
```

Four things are worth reading in that summary, because they are what a mistake or
an attacker would change:

- The **shasum** equals the reviewed artifact's. This is the one that matters.
- The **version** is the one you intended, and matches the tag you pushed.
- **Staged by** says `GitHub Actions (trusted automation)`. Anything else means
  something other than the workflow put it there.
- **Access** is `public`, and **status** is `staged` rather than already live.

The file list and unpacked size are still worth knowing, and CI asserts both
before anything is staged: the exact eleven paths this package ships, and that
`SDK_VERSION` matches the manifest. That check runs in the workflow, so a drift
fails the run rather than reaching this step.

To discard instead:

```bash
npm stage reject <stage-id>
```

Rejecting is cheap and leaves no trace on the registry. A version number is not
consumed by a rejected stage, so the same version can be staged again once
whatever was wrong is fixed.

### Why approval cannot be automated

`npm stage approve` requires an interactive 2FA challenge and will not accept an
OIDC token, so there is no way to wire it into CI even by accident. If a future
change appears to automate it, that change is either wrong or is quietly
re-enabling direct publishing, and it should be refused on sight.

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
