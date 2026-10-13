# Reproducing the Node.js SIP case study

Run from the repository root on branch `case-study/node-sip-benchmark`.
The article is in `docs/docker-blog-draft.md`; experimental qualifications are
in `docs/sip-benchmark-report.md`. No production release workflow is changed.

## Local application and boundary tests

```bash
node scripts/validate-lockfile-age.mjs
npm ci --ignore-scripts
npm test
npm run lint
```

The recorded test host used Node 22.22.3 and npm 11.14.1. Container targets use
Node 26.3.0; rerun tests with that version before publication. `lint` performs
JavaScript and shell syntax checks, not ESLint. Tests use Node's built-in test
runner. The lifecycle fixture is a local tarball with a harmless marker-writing
postinstall script; no malicious dependency is downloaded. Its positive control
explicitly enables the script inside a temporary directory.

## Container comparison

Prerequisites: running Docker daemon, Buildx, jq, Node/npm, Trivy (use the release
workflow's 0.72.0 for comparison), access to DHI, and push/pull access to a
**dedicated benchmark registry repository**. Authenticate interactively with
`docker login dhi.io` and your benchmark registry. Do not use production tags.
Confirm these exact base tags are available; the harness records their digests
or fails. It does not silently substitute a different Node or Debian version.

```bash
docker version
docker buildx version
trivy --version
BENCHMARK_IMAGE=ghcr.io/YOUR_ACCOUNT/sip-benchmark \
  REPETITIONS=3 node experiments/scripts/benchmark.mjs
```

Replace `YOUR_ACCOUNT` with its lowercase value. The harness creates unique
baseline/hardened candidate tags. It never promotes them. Each run writes raw
command logs, image metadata, SBOM/provenance exports, runtime scan reports,
attached-SBOM gate results and `results.json` under `experiments/results/run-*`.
Failed preflights also write `results.json`; missing data are not zeroes.

Both variants copy the same root `src/`, `package.json`, `package-lock.json` and
`tsconfig.json`. Baseline uses a conventional multi-stage official Node slim
image and `npm ci`, so a deliberately bloated image or unlocked install does not
bias the comparison. It omits `.npmrc`, uses default lifecycle behavior and has
no release gate. Hardened mirrors the root Dockerfile with base-image ARGs so
the harness can pin resolved digests. Keep the two Dockerfiles aligned when the
reference changes. Only the hardened path calls the age validator first.

The intended distribution match is Debian 13 (official Node `trixie-slim`, DHI
`debian13`), Node 26.3.0, linux/amd64. Actual image availability, bundled npm,
OS details, shell/package-manager absence and user identity remain unverified
until a successful container run. Record these from image inspection/runtime
commands before drawing conclusions; do not infer them from tag spelling.

The harness alternates variant order and uses `--no-cache --pull`. This disables
Dockerfile layer reuse, not host/network/base-download caches. Median build
seconds include push and, for SIP, attestation generation. Runtime vulnerability
counts use the same Trivy database snapshot, include unfixed findings, and count
finding occurrences, not distinct CVE identifiers. Attached-SBOM scanning is
reported separately because its coverage can differ. Compressed layer bytes
sum the selected platform manifest's layer descriptor sizes, excluding config,
index and attestations; local image bytes are Docker's `.Size`. Neither is disk
space reclaimed or incremental transfer size.

## Release checks and remaining measurements

The experimental promotion helper checks eligibility and verifies tag digest
identity after promotion. Invoke it **only after a successful attached-SBOM gate**
and against a disposable benchmark tag; it does not authenticate approval or
verify evidence itself. For example, after a successful hardened run:

```bash
export IMAGE=ghcr.io/YOUR_ACCOUNT/sip-benchmark
export DIGEST=sha256:REPLACE_WITH_RECORDED_DIGEST
export REF_TYPE=branch REF_NAME=main PROMOTION_TAG=verified-benchmark
scripts/retrieve-attached-sbom.sh
trivy sbom --scanners vuln --severity CRITICAL --ignore-unfixed \
  --exit-code 1 sbom.spdx.json
experiments/scripts/promote.sh
```

A tag pattern is an eligibility policy, not proof of organizational approval.
Protect refs and environments separately. The helper's post-check detects a
mismatch; it cannot make mutable tags atomic or roll back a wrong promotion.
The production workflow already promotes by candidate digest; its behavior has
not been replaced with this experimental helper.

Complete CI pipeline duration is **Not measured**. A local harness duration is
not that metric. Run matched isolated baseline and SIP workflows on identical
runner types in a disposable fork, record run/job start and completion times
(including the chosen queue/approval policy), and export with:

```bash
gh api repos/OWNER/REPO/actions/runs/RUN_ID > run.json
gh api repos/OWNER/REPO/actions/runs/RUN_ID/jobs > jobs.json
```

No new benchmark workflow was dispatched. Historical runs are not replacements.
For reproducibility, compare per-platform manifests and application output as
well as whole image indexes: timestamped provenance may change index digests.
Do not claim bit-for-bit reproducibility from lockfile pinning alone.

Docker Sandboxes isolation is **Not measured**. A working Sandboxes installation
and controlled host-filesystem/network/credential boundary probes are required;
configuration text is not runtime evidence.
