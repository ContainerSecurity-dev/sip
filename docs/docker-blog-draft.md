# SIP It Before You Ship It: Building a Verifiable Node.js Release Pipeline with Docker

A Node.js container can build successfully, start correctly, and still leave a release engineer with an uncomfortable question: **is the image we are about to publish the image we actually checked?**

A passing build answers whether the Dockerfile completed. It does not tell us whether a locked dependency was published moments ago, whether an installation script ran, whether a software inventory exists, or whether the release tag points to the scanned candidate.

I used a small Express and TypeScript application to examine those gaps. The application returns a JSON greeting. Keeping it deliberately ordinary puts the engineering work where it belongs: dependency installation, the Docker build, evidence collection, and release promotion.

This is the practical side of [SIP, a five-control supply-chain framework](https://containersecurity.dev/blog/sip). The [reference implementation](https://github.com/ContainerSecurity-dev/sip) connects dependency checks, Docker Hardened Images, BuildKit attestations, and a vulnerability gate. The interesting part is what happened when we tested the connections.

## Start with the same application

The comparison uses identical source and the same lockfile. The baseline is a conventional multi-stage build using the official Node slim image, `npm ci`, and ordinary lifecycle-script behavior. It has no SIP-specific dependency validator or release gate.

The hardened variant follows the existing reference Dockerfile: separate Docker Hardened Images for development and runtime, installation with scripts disabled, and explicit non-root execution. Its pipeline validates the lockfile before building, attaches evidence, and gates release.

Using a multi-stage baseline matters. Leaving compilers and development dependencies in an artificially oversized baseline would make a compelling chart and a poor experiment. Both variants compile the application and prune development dependencies. Both containers ran Node 26.3.0 on Debian 13 for linux/amd64. Both build environments used npm 11.16.0.

We ran three builds of each variant on the same Docker Desktop host, alternating their order. Trivy 0.72.0 ran from a digest-pinned Docker image against a single database snapshot, updated on October 13, 2026. Images were pushed to a disposable local registry.

The result was useful precisely because it was not a clean bill of health: the hardened image was smaller and had fewer detected vulnerabilities, but its release gate still failed.

## A lockfile needs more than a cooldown setting

The first issue appeared before Docker entered the picture.

The repository configures a five-day release cooldown and disables lifecycle scripts:

```ini
min-release-age=5
ignore-scripts=true
```

But a dependency-resolution policy and a locked installation answer different questions. `npm ci` installs the versions already selected in the lockfile. A release pipeline therefore needs an explicit check of those versions, rather than assuming a resolution-time cooldown rechecks them.

The reference runs that check before installation:

```bash
node scripts/validate-lockfile-age.mjs
npm ci --ignore-scripts
npm run build
npm test
```

The validator retrieves public npm metadata, checks publication timestamps, and compares each locked tarball URL and integrity value with the registry’s version metadata. Missing or inconsistent evidence causes failure.

Comparing it with the [SIP agent skill](https://github.com/ContainerSecurity-dev/sip-skill) exposed a narrower problem: the reference’s cooldown exclusions skipped the entire validation path for an excluded package. An exception intended to permit a fresh security update also bypassed artifact-identity checks.

The experiment reuses the skill’s tested validator so an exclusion applies only to age. URL and integrity comparisons still run. It also brings bounded retries and request timeouts into the reference, while retaining the fixed five-day CLI policy. Temporary registry failures should receive a bounded chance to recover; unavailable metadata should not turn into approval.

A deterministic fixture rejected a dependency published four days before the test clock and accepted one exactly at the five-day threshold. Separate checks rejected altered tarball URLs, mismatched integrity, and invalid timestamps. Live registry validation produced this output:

```text
Validated 158 locked packages against a 5-day cooldown (0 excluded locked packages).
```

That is a count of lockfile entries, including optional dependencies, not packages shipped in the runtime image. Nor does age establish safety. It creates a waiting period; the metadata comparisons bind the decision to the registry artifact being requested.

## Test whether installation code can execute

The lifecycle-script test uses an intentionally harmless local package. Its `postinstall` hook writes a marker file inside the temporary test directory.

With `npm ci --ignore-scripts`, installation succeeds and the marker does not appear. A positive control explicitly enables scripts and confirms that the marker does appear. Without that positive control, an absent marker could simply mean a broken fixture.

The same fixture also checks that npm rejects a deliberately corrupted integrity value. This separates two properties: suppressing automatic installation hooks and checking the downloaded artifact against its lockfile integrity.

Neither property makes arbitrary application code safe. Disabling installation hooks also requires care with legitimate packages that depend on a build step. Exceptions should be deliberate, reviewed work—not a reason to restore automatic scripts globally.

## Keep build tools out of the runtime

The hardened Dockerfile separates compilation from execution. Its central pattern is straightforward:

```dockerfile
FROM dhi.io/node:26.3.0-debian13-dev AS build
ARG BUILDKIT_SBOM_SCAN_STAGE=true
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
```

After compilation and pruning, the runtime stage copies the application output and production dependencies and selects `USER node`. The [Docker Hardened Images usage guide](https://docs.docker.com/dhi/how-to/use/) explains how development and runtime variants fit this workflow.

The harness resolves base tags to immutable digests before comparing variants. Runtime probes confirmed UID 1000 in the hardened container, with neither `/bin/sh` nor npm available. The conventional image ran as root and retained both. These are observations about the selected images, not properties to assume from a tag name.

Median compressed layer size fell from 85.02 MB to 42.96 MB. The result includes the combined effects of the different base contents and runtime packaging; it does not isolate a single Dockerfile instruction.

## Attach evidence to the candidate

BuildKit can generate an SBOM and provenance while building the image. For a configured experimental registry and source checkout, the hardened build follows this form:

```bash
docker buildx build \
  --platform linux/amd64 \
  --file experiments/hardened/Dockerfile \
  --sbom=true --provenance=mode=max \
  --metadata-file build.json \
  --tag "$BENCHMARK_IMAGE:candidate" \
  --output type=image,push=true,oci-mediatypes=true,oci-artifact=true .
```

The full harness additionally pins the base-image digests. The build metadata records the resulting candidate digest, which becomes the reference for subsequent verification.

An SBOM describes detected components; provenance describes aspects of the build. Neither establishes that the source is benign or that the builder deserves trust. Their value here is concrete: they give the release gate evidence associated with an identified artifact. Docker documents [SBOM generation and stage selection](https://docs.docker.com/build/metadata/attestations/sbom/) and [provenance modes](https://docs.docker.com/build/metadata/attestations/slsa-provenance/).

Inspect the scope, too. BuildKit exported a runtime inventory and an additional build-stage inventory. TypeScript was absent from both after pruning, and the existing release script passes only the runtime inventory to Trivy. Generating additional evidence is not the same as enforcing a policy over it; this reference does not establish complete build-dependency coverage.

## Make missing evidence a release failure

The repository’s historical review found another consequential gap: requesting an attached SBOM from a scanner was not equivalent to requiring one. Best-effort discovery could fall back to scanning image layers.

The corrected reference makes retrieval a separate step:

```bash
docker buildx imagetools inspect "$IMAGE@$DIGEST" \
  --format '{{ json .SBOM.SPDX }}' > sbom.spdx.json

jq -e '.spdxVersion and (.packages | type == "array") and
  (.packages | length > 0)' sbom.spdx.json

trivy sbom --scanners vuln --severity CRITICAL \
  --ignore-unfixed --exit-code 1 sbom.spdx.json
```

The structural check rejects absent or empty evidence before scanning. It is a minimal guard, not full SPDX validation or signature verification.

Fixture tests rejected null output, empty inventories, malformed JSON, and retrieval failure. The live baseline image also failed attached-SBOM retrieval. More significantly, the real hardened SBOM scan found a fixable Critical vulnerability in `proxy-addr`, with version 2.0.8 reported as the fix. All three hardened candidates failed the gate.

The policy blocks fixable Critical findings. It does not imply that High findings or unfixed Critical findings are acceptable forever. Those need an explicit operational response outside this narrow release condition.

The production workflow is designed to promote the verified digest with `docker buildx imagetools create`, without rebuilding. An experimental helper adds a post-promotion equality check, which rejects a mocked mismatch. We did not promote the measured candidates: their failed gate is a reason to stop, not a benchmark inconvenience to bypass.

## What the results support

All 12 application and security tests passed under Node 26.3.0 after supplying the shell tests’ jq prerequisite. All six containers returned the expected JSON response.

| Measurement | Conventional baseline | SIP variant |
| --- | --- | --- |
| Median compressed layer size | 85.02 MB | 42.96 MB |
| Median Docker-reported local size | 352.87 MB | 191.69 MB |
| Critical findings | 5 | 1 |
| High findings | 97 | 6 |
| Medium findings | 147 | 61 |
| Low findings | 90 | 44 |
| Unknown-severity findings | 3 | 0 |
| Median build and push | 6.41 s | 13.90 s |
| Median dependency validation | No additional check | 3.19 s |
| Median attached-SBOM retrieval and scan | No additional gate | 0.41 s |
| Attached SBOM / provenance | Absent / absent | Present / present |
| Complete CI pipeline duration | Not measured | Not measured |

MB means decimal megabytes. Compressed size sums runtime-layer descriptors; local size is Docker’s `.Size`, not incremental disk usage. Vulnerability counts are finding occurrences from comparable runtime image scans, including unfixed findings. They remained identical across repetitions. The separate release gate uses the attached SBOM and blocks fixable Critical findings.

Build timings include push and, for SIP, attestation generation. Dockerfile cache reuse was disabled, but base downloads and other host caches could warm. These are local medians, not hosted CI timings or a controlled estimate of one feature’s cost. Both variants produced different digests across rebuilds: pinned inputs alone did not deliver bit-for-bit reproducibility.

A separate npm audit reported six dependency vulnerability entries: one Critical, four High, and one Moderate. Those results include development dependencies and are preserved in the evidence bundle. They are not image CVE counts and cannot predict the attached-SBOM gate’s result.

Even a future scan returning zero detected CVEs would describe one scanner, inventory, database, and point in time. It would not establish a vulnerability-free application.

## The review was part of the engineering

[PR #2](https://github.com/ContainerSecurity-dev/sip/pull/2) provides a useful record of how the implementation developed. Qodo identified the lockfile cooldown bypass and weak SBOM retrieval. Copilot independently raised the SBOM issue and flagged npm compatibility, unrestricted manual release refs, and overlapping promotion runs.

The current workflow explicitly validates dependencies, retrieves evidence, restricts manual refs, and cancels superseded runs by ref. Historical successful Actions runs support that implementation history; they are not measurements from this experiment.

Some limits remain. Ref-based cancellation cannot make a registry update transactional, and a permitted tag name is not human approval. In a separate Docker Sandboxes 0.48.0 shell sandbox, runtime probes confirmed that a host-only file and environment variable were inaccessible, sandbox writes did not appear on the host, and deny-all networking blocked the test request. Those narrow probes support local isolation; they are not an exhaustive escape assessment or a claim about CI sandboxing.

## Reproduce the checks, then fill in the measurements

The experimental branch includes the blog’s supporting report, fixtures, raw outputs, and reproduction instructions:

```bash
git clone https://github.com/ContainerSecurity-dev/sip.git
cd sip
git switch case-study/node-sip-benchmark
node scripts/validate-lockfile-age.mjs
npm ci --ignore-scripts
npm test
npm run lint
```

On a Docker-enabled host with registry access, run the documented harness; it launches Trivy from its pinned container image. It alternates variant order, records base and candidate digests, retains scanner output, and separates comparable runtime scans from the attached-SBOM gate. It keeps compressed layer bytes separate from local image size and reports medians only when measurements exist.

The next step is to remediate the remaining dependency finding and repeat verification, then measure a full hosted CI run. This experiment already demonstrates a valuable outcome: the pipeline produced a smaller image, recorded its evidence, and refused to release it. Check the dependency artifact, require the evidence, and carry the same digest through verification and promotion.
