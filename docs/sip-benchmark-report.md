# SIP Node.js experimental report

Evidence collection date: 2026-10-13 (Europe/Berlin). Raw timestamps use UTC.
Reference commit: `4ab400eaa9db740ea7aef72a33efa5ac6e68745f`.
Skill reference: `5888d6d6e562654c919cde0c21023e2db473407d`.
Branch: `case-study/node-sip-benchmark`.

## Findings and limits

The application compiled and all 12 Node test cases passed. Live validation
accepted 158 locked package entries under the five-day policy with no
exclusions. These entries include optional packages; they are not a count of
packages shipped in the runtime image. Node was 22.22.3, npm 11.14.1, Docker
client 29.5.3 and Buildx 0.37.2 on Linux x86_64. The Docker desktop-linux socket
was missing even outside the execution sandbox. Trivy and `sbx` were absent.
Container Node 26.3.0 was not executed. The preflight recorded these facts in
`experiments/results/environment/`.

| Requested metric | Baseline | SIP |
| --- | --- | --- |
| Compressed registry layer bytes | Not measured | Not measured |
| Local image bytes | Not measured | Not measured |
| Critical / High / Medium / Low image CVEs | Not measured | Not measured |
| Container build duration | Not measured | Not measured |
| Complete CI duration | Not measured | Not measured |
| Security verification duration | N/A (no gate) | Not measured |
| Attached SBOM availability | Not measured | Not measured |
| Attached provenance availability | Not measured | Not measured |
| Bit-for-bit rebuild reproducibility | Not measured | Not measured |

No image digests, scanner DB update time, median build duration or container
savings are available. The preflight tool-call durations are not benchmark
measurements. `npm-audit.json` reports six dependency vulnerability entries:
one Critical, four High and one Moderate. This audit includes development
dependencies, is not a Trivy scan, and cannot establish the container gate's
outcome. The existing dependency graph was retained to avoid confounding the
comparison. Resolve/audit its findings before making a production-readiness claim.

## Changes

Reused the skill validator and its tests. Age exclusions now skip only age
checking; registry tarball URL and integrity comparisons still run. Metadata
requests have bounded retries and timeouts. Await JSON parsing inside the retry
block so asynchronous body failures also receive bounded retries. The CLI
retains the reference's fixed five-day minimum rather than introducing an
environment-variable bypass. Public npm is the only supported registry; this
is not a general workspace/private-registry validator. Linked or versionless
entries are skipped by the reused collector, so unsupported lockfile sources
need an explicit policy before broader adoption.

The application exports its Express instance for HTTP tests without changing
its response or startup behavior. `npm test` replaces the original placeholder.
No feature, dependency version, root Dockerfile, or release workflow changed.
The optional promotion helper is experimental and is tested with a fake Docker
CLI, not against a live registry.

## Boundary tests

| Boundary | Expected | Observed | Outcome and evidence class |
| --- | --- | --- | --- |
| Recent dependency | Reject a four-day-old fixture | Validator rejects | Pass, mocked registry |
| Exact age threshold | Accept a five-day-old fixture | Validator accepts | Pass, mocked clock/registry |
| Lifecycle script | Marker absent with ignore-scripts | Absent; present with explicit enablement | Pass, real npm/local tarball |
| Tampered lockfile | Reject altered integrity/URL | Validator rejects; npm rejects bad tarball integrity | Pass, mocked metadata plus real npm |
| Missing/invalid SBOM | Stop before scan | null, empty, malformed JSON and CLI failure reject | Pass, mocked Docker |
| Fixable Critical finding | Release gate exits nonzero | Fixture count makes workflow gate fail | Pass, mocked Trivy output, not scanner detection |
| Ineligible release ref | Reject feature branch/non-v tag | Nonzero; promotion Docker never invoked | Pass, real shell policy |
| Digest identity | Promote verified digest; reject mismatch | Correct argument and equality check | Pass, mocked Docker; live promotion Not measured |
| Agent isolation | Isolate host resources | No Sandboxes runtime | Not measured |

`tests.tap` is the raw test output. `security-results.json` provides structured
outcomes. The SPDX shell check is a minimal structural guard, not full schema
validation, authenticated provenance, or proof of inventory completeness.
The fixture tests establish control flow, not end-to-end registry behavior.

## Historical review and current implementation

Raw public PR #2 reviews/comments and workflow-run metadata are preserved under
`experiments/results/historical-*`. They corroborate the repository's existing
`docs/pr-2-review-comparison.md`. Qodo identified lockfile cooldown bypass and
best-effort SBOM retrieval. Copilot independently identified SBOM fallback and
also flagged unsupported npm, manual ref eligibility and promotion races.

Current source at the reference commit validates lockfile metadata before
installation, extracts `.SBOM.SPDX` from the candidate digest, scans that file,
checks manual refs, and uses ref-scoped cancellation. Dependency and image jobs
check out the same candidate SHA. Promotion depends on successful vulnerability
verification and uses the build's digest rather than rebuilding. This was
verified by source inspection, not by a new production release.

The review document's description of pinning npm 11.10.0 is historical: current
CI pins Node 26.3.0 and does not separately install that npm version. Ref-scoped
cancellation mitigates overlap but is not a transactional registry lock. A
cancellation can race an already-issued registry write. Environment protection
settings and branch/tag governance have not been audited here.

A successful historical run exists at
https://github.com/ContainerSecurity-dev/sip/actions/runs/31799964519
for the reference commit. Earlier success and failure records are in the raw
JSON. No historical elapsed time or result is counted as a fresh benchmark.

## Reproduction and publication blockers

See `experiments/README.md`. Benchmark scripts pass syntax checks and preflight;
container portions are not runtime-validated. The harness pins base digests,
uses matched source and intended Node/distribution versions, alternates order,
records a fixed vulnerability DB snapshot, separates runtime scans from the
SBOM gate and produces medians only for completed runs.

Before publication as a measured container comparison: execute the harness,
confirm both images' OS/Node/npm/user/entrypoint behavior, inspect SBOM coverage
(including whether pruned development packages remain represented), test real
attestation retrieval and promotion, gather equivalent CI runs, and rerun tests
on Node 26.3.0. Record sandbox isolation only if tested. The blog is written as
an editorial entry with these limitations visible; it is not a finished
quantitative performance case study.

## Claim-to-evidence map

- Twelve passing tests: `experiments/results/tests.tap`.
- Five-day policy, four-day fixture, exact boundary: validator and test source.
- 158 locked entries / zero exclusions: `live-lockfile-validation.log`.
- Six audit entries and severity breakdown: `npm-audit.json` metadata.
- Host/tool versions and absent Docker daemon: `environment/results.json` and logs.
- Node 26.3.0 / Debian 13: configured Dockerfile tags, not runtime measurements.
- Historical engineering findings: PR #2 comments and review comparison.
- All container performance/CVE/attestation availability claims: Not measured.
