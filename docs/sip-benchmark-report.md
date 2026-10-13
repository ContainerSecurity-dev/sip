# SIP Node.js experimental report

Measured on 2026-10-13 (Europe/Berlin); raw timestamps are UTC unless noted.
Reference commit: `4ab400eaa9db740ea7aef72a33efa5ac6e68745f`.
Skill reference: `5888d6d6e562654c919cde0c21023e2db473407d`.
Branch: `case-study/node-sip-benchmark`.

## Main finding

Three builds per variant completed and all six application probes passed.
The hardened images were smaller and had fewer detected vulnerabilities, but
**all three attached-SBOM gates failed** on a fixable Critical vulnerability in
`proxy-addr`. No benchmark candidate was promoted. A smaller hardened base did
not repair a vulnerable application dependency.

Both images ran Node 26.3.0 on Debian 13, linux/amd64. Both build environments
used npm 11.16.0. Baseline ran as UID 0 with a shell and npm. Hardened ran as UID
1000 without `/bin/sh` or npm. Docker client was 29.5.3, server 29.8.2 (Docker
Desktop 4.95.0), Buildx 0.37.2, BuildKit 0.33.1, Trivy 0.72.0. The host controller
used Node 22.22.3/npm 11.14.1. Docker Sandboxes was 0.48.0.

Earlier preflight failures are preserved in `environment/` and `docker-run/`.
The initial Docker socket was unavailable; it subsequently became available.
The first containerized Trivy attempt failed because Docker Desktop could not
mount the host `/tmp` checkout. Moving the checkout to a shared home directory
resolved this. The completed measurements are in `docker-run-2/`; earlier
failures are not included in medians.

## Measured comparison

| Metric | Baseline | SIP |
| --- | ---: | ---: |
| Median compressed runtime-layer bytes | 85,020,680 | 42,957,626 |
| Median local image bytes (`docker image inspect .Size`) | 352,869,885 | 191,693,726 |
| Critical findings | 5 | 1 |
| High findings | 97 | 6 |
| Medium findings | 147 | 61 |
| Low findings | 90 | 44 |
| Unknown-severity findings | 3 | 0 |
| Median build + push seconds | 6.41465 | 13.89942 |
| Median lockfile verification seconds | N/A | 3.18848 |
| Median attached-SBOM retrieval + gate scan seconds | N/A | 0.41143 |
| Median local harness seconds | 8.29063 | 19.70174 |
| Complete hosted CI pipeline seconds | Not measured | Not measured |
| Attached SBOM / provenance | Absent / absent | Present / present |
| Repeated index digest identity | Different in all three | Different in all three |

MB in the blog means 1,000,000 bytes. Local `.Size` is Docker's reported size,
not a measurement of unpacked-only bytes, incremental disk use or transfer
cost. Compressed size sums the selected platform's layer descriptors, excluding
config, manifest/index and attestation objects. Sizes varied slightly across
runs; the table reports medians. CVE counts were stable across all repetitions.

Trivy's DB `UpdatedAt` was `2026-10-13T19:11:46.909502157Z`, downloaded at
`2026-10-13T20:21:29.355003421Z`. Subsequent scans used `--skip-db-update`.
Runtime image scans include unfixed findings, all severities and finding
occurrences rather than deduplicated CVE IDs. The SIP gate instead scans the
attached runtime SBOM, filters to fixable Critical findings and exits 1. Its
recorded finding is `CVE-2026-90711`, package `proxy-addr`, fix version `2.0.8`.
This is a scanner observation from that DB snapshot, not independent exploit
validation. npm audit is separate and must not be used as container scan data.

Alternating order was baseline/SIP, SIP/baseline, baseline/SIP. Builds used
`--no-cache --pull`, fixed base digests, identical source and a local registry.
Base downloads, network and host caches were not reset. The first pair includes
more setup/pull overhead; no samples were discarded. Timings include push and,
for SIP, attestations. They do not isolate DHI, SBOM or provenance overhead.
The harness adds diagnostic runtime scans to both paths and is not a CI pipeline.
No new hosted workflow was dispatched, so complete CI duration remains unmeasured.

A supplemental single-pair harness validation is retained in `harness-validation/`
and excluded from the comparison medians. It verifies the updated image-tag
recording and scanner-error checks.

## Artifact and source identity

`docker-run-2/results.json` records all six candidate digests and base digests.
Build tags are also present in raw build logs and per-run `build.json` files.
`summary.json` contains the medians. `measured-sources.json` hashes source,
lockfile, Dockerfiles, validator and the exact harness snapshot used for the run.
The controller ran from commit `549e116f2c260793cae9816916894c83431b9e49`
with recorded working-tree changes. `benchmark-source.mjs` preserves that
measurement version; subsequent harness improvements do not rewrite old results.

Trivy image:
`aquasec/trivy:0.72.0@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f`.

Local registry tags are disposable; raw manifests, scans and attestations are
retained as evidence, including after cleanup. Large raw files are losslessly
gzip-compressed. Use `gzip -dc FILE.json.gz` to inspect them. Rebuilding can yield
different indexes, platform manifests and layer sizes; bit-for-bit reproducibility
was not achieved and its sources of variation were not isolated.

## Security verification

| Boundary | Expected | Observed | Evidence |
| --- | --- | --- | --- |
| Recent dependency | Reject four-day-old fixture | Rejected; exact five-day threshold accepted | Mock registry/clock, passing unit tests |
| Lifecycle script | No marker with scripts disabled | Absent; positive control writes marker | Real npm/local tarball |
| Tampered lockfile | Reject wrong URL/integrity | Rejected | Mock metadata plus real npm integrity failure |
| Missing/invalid SBOM | Stop before scanner | Live baseline rejected; malformed fixtures rejected | `missing-sbom-test.json`, tests |
| Fixable Critical | Prevent release | All real hardened scans exited 1 | Three `gate.json` files |
| Ineligible release ref | Reject feature/non-v refs | Rejected before Docker invocation | Real shell policy tests |
| Candidate/release digest | Preserve verified identity | Mock checks passed; live promotion not attempted after failed gate | Tests; no release claim |
| Sandbox file/environment isolation | Host-only markers unavailable | Unavailable; sandbox writes absent on host | `sandbox/probes.txt` |
| Sandbox network isolation | Deny test domain | HTTP 403, curl --fail exit 22; policy log says default deny | Sandbox runtime and policy logs |
| Sandbox Docker separation | Host registry container invisible | Separate daemon 29.8.1; host container not found | Sandbox runtime logs |

All 12 tests passed on host Node 22 and on container Node 26.3.0. The first
Node 26 test attempt lacked jq, which the shell tests need. A separate test-only
image supplies jq; `node26-tests-with-jq.log` records the successful run.
Application response and unknown-route behavior are tested. Live registry
validation accepted 158 locked entries with zero age exclusions; entries include
optional dependencies, not just shipped runtime packages.

Sandboxes initially had no global policy and no existing sandboxes. The run
initialized deny-all, then created a workspace-free shell sandbox with shared
skills disabled. It did not run an AI agent or mount production credentials.
These controlled probes verify selected observed boundaries, not resistance to
all escapes, credential-proxy behavior or CI sandboxing. The reproducible probe
script requires a deny-all test installation and leaves global policy untouched.

## Engineering changes and remaining gaps

Reused the SIP skill's validator/tests: age exclusions no longer skip artifact
URL/integrity checks, and registry requests have bounded retries/timeouts. JSON
body failures are awaited inside the retry block. The CLI retains the fixed
five-day policy. Public npm is the supported source; linked/versionless entries
are skipped by the reused collector, so broader workspace/private-source
policies require further work.

The Express app is exported for HTTP tests; startup and response behavior are
preserved. The placeholder npm test was replaced. Root Dockerfile, dependency
versions and production release workflow remain unchanged. Hardened experimental
Dockerfile adds only base-image ARGs for digest pinning. The optional promotion
helper adds a post-write digest comparison but is not wired into production.

The runtime SBOM contained 99 package entries. Its additional build-stage SBOM
contained 426; neither contained TypeScript after pruning. The existing scanner
passes only `.SBOM.SPDX`, not `.AdditionalSPDXs`, to Trivy. Build-stage evidence
therefore does not imply build-stage gate coverage. The minimal SPDX guard is
not full schema validation, authenticated provenance or inventory-completeness
proof. Broader evidence coverage needs a deliberate follow-up.

## Historical evidence and publication scope

Public PR #2 reviews/comments and historical runs remain in `historical-*`.
Qodo identified cooldown bypass and best-effort SBOM retrieval. Copilot also
flagged npm compatibility, manual release eligibility and promotion races.
Current source uses explicit validation, separate SBOM extraction, ref checking,
ref-scoped cancellation, the same source SHA for dependency/build jobs and
promotion from the candidate digest. Historical results are not fresh timings.
The old review document's npm 11.10.0 installation is historical; current CI pins
Node 26.3.0 instead. Cancellation is not a transactional registry lock, and
repository/environment approval settings were not audited.

The blog now supports a measured local comparison and a real failed security
gate. Remaining unmeasured items are full hosted CI duration and successful
live release promotion. A green-release claim requires remediating the recorded
dependency finding and rerunning the same gate; it must not be bypassed to finish
a benchmark. Claims of complete build-time dependency scanning remain unsupported.

## Claim map

- Sizes, durations, CVEs, digests: `docker-run-2/results.json`, `summary.json`, raw scans.
- Actual OS/UID/shell/npm: `runtime-environment.json`, `hardened-build-npm.txt`.
- SBOM coverage: `sbom-coverage.json` and raw `sbom.json`.
- Gate rejection: per-run `gate.json`, scan logs, `missing-sbom-test.json`.
- Tests: `tests.tap`, `node26-tests-with-jq.log`.
- 158 entries: `live-lockfile-validation.log`.
- Audit findings: `npm-audit.json` (not a container measurement).
- Sandbox boundaries: `sandbox/` and `sandbox-script-run/`.
- Broader history: PR #2 review and raw public GitHub metadata.
