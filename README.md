# SIP supply-chain security sample

This repository is a runnable reference implementation of the **Security
Immediate Plan (SIP)** for a Node.js container application. The application is
intentionally small—a TypeScript Express server—so the supply-chain controls are
easy to inspect without unrelated framework complexity.

SIP follows one ordered chain:

```text
AI agent → dependencies → container build → attestations → vulnerability gate
```

Each control strengthens the input to the next. The image promoted to a release
is the exact digest whose BuildKit-generated SBOM passed the vulnerability gate;
there is no rebuild between scanning and promotion.

## Repository map

| SIP control | Implementation |
| --- | --- |
| i. Isolate local AI agents | Developer-side Docker Sandboxes policy and secret storage; guidance below |
| ii. Freeze unvetted dependencies | [`.npmrc`](.npmrc), committed `package-lock.json`, and [`scripts/validate-lockfile-age.mjs`](scripts/validate-lockfile-age.mjs) |
| iii. Harden container builds | Multi-stage [`Dockerfile`](Dockerfile) using Docker Hardened Images |
| iv. Generate attestations | BuildKit settings in [`.github/workflows/release.yml`](.github/workflows/release.yml) |
| v. Scan the attested SBOM | Pinned Trivy, explicit SPDX extraction, PR reporting, and digest promotion in the workflow |

## Application

The sample requires Node.js 26.3.0 or a compatible Node 26 release. Node 26
includes npm 11, which understands the `min-release-age` policy without
bootstrapping an unlocked package-manager dependency.

Install and run locally:

```bash
npm ci --ignore-scripts
npm run dev
```

The server listens on `http://localhost:3000` by default.

Build and run the compiled application:

```bash
npm run build
npm test
npm start
```

## SIP i — isolate local AI agents

Agent isolation is a developer-workstation control, not a GitHub Actions control.
Run local coding agents inside Docker Sandboxes when available. Initialize a
deny-by-default policy before creating task-specific network allowances:

```bash
sbx policy init deny-all
sbx policy allow network "api.openai.com,github.com,*.npmjs.org"
```

Keep credentials in host-side sandbox storage rather than exposing raw tokens to
the agent:

```bash
sbx secret set openai --oauth
sbx secret set github
sbx run codex .
```

Do not reset or weaken an existing sandbox policy without first reviewing every
sandbox that depends on it.

## SIP ii — freeze unvetted dependencies

The repository npm policy is:

```ini
min-release-age=5
ignore-scripts=true
```

`ignore-scripts=true` disables dependency lifecycle scripts. Every automated
install also states `npm ci --ignore-scripts` explicitly and uses the committed
lockfile.

There is an important lockfile nuance: `npm ci` installs already-locked versions
without resolving new candidates, so `min-release-age` alone does not reject a
recent version that is already present in `package-lock.json`. SIP ii therefore
runs the lockfile-age validator before installation. It queries npm publication
metadata in bounded batches and fails closed when a locked version:

- is younger than five days;
- has no verifiable publication timestamp; or
- cannot be checked because registry metadata is unavailable.

No cooldown exclusions are configured. If a required security update is less
than five days old, review it and add a narrowly scoped
`min-release-age-exclude` entry rather than weakening the policy globally.

Run the same check locally with:

```bash
node scripts/validate-lockfile-age.mjs
```

## SIP iii — harden container builds

The Dockerfile uses two pinned Docker Hardened Image variants:

- Build: `dhi.io/node:26.3.0-debian13-dev`
- Runtime: `dhi.io/node:26.3.0-debian13`

The build image contains npm and the tools needed to compile TypeScript. After
the build, development dependencies are pruned. The runtime image receives only
`package.json`, production `node_modules`, and compiled `dist` output. It runs as
the non-root `node` user.

Both Dockerfile stages declare:

```dockerfile
ARG BUILDKIT_SBOM_SCAN_STAGE=true
```

Dockerfile `ARG` scope is stage-specific. Declaring the argument in both stages
ensures the generated inventory includes relevant build-stage packages as well
as the minimal runtime contents.

## SIP iv — generate SBOM and provenance attestations

The `SIP iii-iv - container and attestations` job performs one container build.
It authenticates to DHI and GHCR, tags the candidate with the source commit SHA,
and uses these BuildKit settings:

```yaml
sbom: true
provenance: mode=max
outputs: type=image,push=true,oci-mediatypes=true,oci-artifact=true
```

The output is an OCI image plus attached SBOM and maximum-level provenance
attestations. The build action's digest output becomes the immutable reference
for every downstream operation.

The GHCR repository name is derived from `${{ github.repository }}` and
normalized to lowercase, so forks or repository transfers do not require a
hard-coded image path.

## SIP v — scan the attached SBOM

The vulnerability job receives the digest from the attestation job. It does not
rescan image layers or trust a mutable tag. Instead, it explicitly extracts the
attached SPDX document:

```bash
docker buildx imagetools inspect \
  "${IMAGE}@${DIGEST}" \
  --format '{{ json .SBOM.SPDX }}' > sbom.spdx.json
```

The job verifies that the document has an SPDX version and a non-empty package
list. Missing, unreadable, or malformed attestations fail the workflow. The
verified file is then scanned with pinned Trivy 0.72.0:

```bash
trivy sbom \
  --scanners vuln \
  --severity CRITICAL \
  --ignore-unfixed \
  --format json \
  --output trivy.json \
  sbom.spdx.json
```

A fixable Critical vulnerability fails the final gate. On pull requests, the
job creates or updates one marker-based comment containing the digest, finding
count, and up to twenty vulnerability rows. The complete result remains visible
in the Actions job output and summary.

## CI/CD job graph

One workflow serves pull requests and releases without rebuilding the image:

```text
SIP ii — dependencies
        │
        ▼
SIP iii–iv — hardened container + attestations
        │
        ▼
SIP v — attached-SBOM Critical CVE gate
        │
        └── pull request: update report comment and stop
        │
        ▼
Release — promote the already-scanned digest
```

The jobs are separated so GitHub clearly identifies whether dependency policy,
container construction, attestation generation, SBOM retrieval, vulnerability
policy, or promotion failed. Container construction and attestation remain one
job because both outputs come from the same BuildKit operation; splitting them
would build the image twice.

### Pull requests

Every PR targeting `main` runs SIP ii. Same-repository PRs continue through the
credential-bearing build and SIP v report. Fork PRs never receive DHI or GHCR
publishing credentials, so they stop after dependency/application validation.
After a fork PR is merged, the trusted `main` run must pass SIP ii–v before any
image can be promoted.

The publishing job uses the `sip-publish` GitHub environment. In production,
protect this environment with required reviewers so changes to the workflow or
Dockerfile cannot access publishing credentials without approval.

### Main, tags, and manual releases

- A push to `main` promotes the scanned digest to `latest`.
- A `v*` tag promotes the scanned digest to that exact tag.
- A manual run is accepted only for `main` or a `v*` tag.
- Ref-scoped concurrency cancels superseded runs, preventing an older run from
  rolling `latest` back after a newer commit succeeds.

Promotion uses `docker buildx imagetools create` with the digest returned by the
build job. It never rebuilds the application after scanning.

## GitHub configuration

The workflow requires:

| Setting | Purpose |
| --- | --- |
| `DHI_USERNAME` | Authenticate to `dhi.io` |
| `DHI_PASSWORD` | DHI password or access token |
| `GITHUB_TOKEN` | Publish candidates, read them by digest, and update PR comments |
| `sip-publish` environment | Approval boundary for the credential-bearing build job |

All third-party GitHub Actions are pinned to verified full commit SHAs. The
workflow grants permissions per job: package write access exists only while
publishing or promoting, package read access is used for scanning, and
pull-request write access is confined to the report job.

For enforcement, configure branch protection or rulesets so the following checks
are required where applicable:

- `SIP ii - dependencies`
- `SIP iii-iv - container and attestations`
- `SIP v - attached SBOM CVEs`

## Lessons captured by this sample

1. **A lockfile and cooldown solve different problems.** A lockfile gives
   reproducibility; publication-age validation governs whether a locked version
   is old enough to trust.
2. **Do not bootstrap policy tooling with an unlocked dependency.** Using a Node
   release that already bundles a compatible npm keeps CI inside the locked
   installation model.
3. **Attestation generation and container construction are one operation.** Keep
   them together to avoid rebuilding and producing a different digest.
4. **SBOM discovery must fail closed.** A best-effort image scan can silently
   fall back to layer analysis. Extracting and validating `.SBOM.SPDX` proves
   which inventory Trivy consumed.
5. **Tags are labels; digests are identities.** Build, scan, report, and promote
   using the digest. Add release tags only after the gate succeeds.
6. **PR credentials need an explicit trust boundary.** Forks do not receive
   publishing credentials, and same-repository publication should be protected
   by environment approval.
7. **Visible job boundaries improve incident response.** Dependency, build and
   attestation, vulnerability, and promotion failures appear separately without
   sacrificing the single-build invariant.

## Validation

Useful local checks are:

```bash
node scripts/validate-lockfile-age.mjs
npm ci --ignore-scripts
npm run build
npm test
actionlint .github/workflows/release.yml
git diff --check
```

An end-to-end validation additionally requires DHI/GHCR credentials and must
confirm that:

- the candidate image is tagged with the source commit SHA;
- BuildKit returns a non-empty digest;
- the registry exposes `.SBOM.SPDX` for that digest;
- Trivy scans the extracted document;
- a Critical finding prevents promotion; and
- promotion references the same scanned digest.
