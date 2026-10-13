# SIP It Before You Ship It: Building a Verifiable Node.js Release Pipeline with Docker

A Node.js container can build successfully, start correctly, and still leave a release engineer with an uncomfortable question: **is the image we are about to publish the image we actually checked?**

A passing build answers whether the Dockerfile completed. It does not tell us whether a locked dependency was published moments ago, whether an installation script ran, whether a software inventory exists, or whether the release tag points to the scanned candidate.

I used a small Express and TypeScript application to examine those gaps. The application returns a JSON greeting. Keeping it deliberately ordinary puts the engineering work where it belongs: dependency installation, the Docker build, evidence collection, and release promotion.

This is the practical side of [SIP, a five-control supply-chain framework](https://containersecurity.dev/blog/sip). The [reference implementation](https://github.com/ContainerSecurity-dev/sip) connects dependency checks, Docker Hardened Images, BuildKit attestations, and a vulnerability gate. The interesting part is what happened when we tested the connections.

## Start with the same application

The comparison uses identical source and the same lockfile. The baseline is a conventional multi-stage build using the official Node slim image, `npm ci`, and ordinary lifecycle-script behavior. It has no SIP-specific dependency validator or release gate.

The hardened variant follows the existing reference Dockerfile: separate Docker Hardened Images for development and runtime, installation with scripts disabled, and explicit non-root execution. Its pipeline validates the lockfile before building, attaches evidence, and gates release.

Using a multi-stage baseline matters. Leaving compilers and development dependencies in an artificially oversized baseline would make a compelling chart and a poor experiment. Both variants compile the application and prune development dependencies. The intended match is Node 26.3.0 on Debian 13, with one Linux architecture; those are configured targets, not verified runtime measurements.

There is also a practical limit to this investigation. On the test host, Docker’s client and Buildx were available, but the configured daemon socket was missing. Trivy and Docker Sandboxes were unavailable. We could execute application and dependency tests, inspect the workflow, and test failure paths with fixtures. We could not measure container size, image vulnerabilities, build overhead, or live registry promotion.

That distinction shapes the results below. An unavailable measurement stays unavailable.

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

The benchmark harness resolves base tags to immutable digests before comparing variants. That makes the selected inputs inspectable even if a tag subsequently moves. It still needs a live run to confirm the exact operating-system packages, bundled npm, entrypoint behavior, and runtime user.

There is no measured image-size reduction to report here. The useful design choice is separating what compilation needs from what serving the application needs; the size and vulnerability effects must be measured for these particular images.

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

Scope needs inspection too. Requesting build-stage scanning does not justify assuming every dependency ever present during compilation appears in the exported inventory. In this Dockerfile, pruning happens in the build stage. A live experiment must inspect the resulting SBOM before making claims about development-dependency coverage.

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

Fixture tests confirmed rejection of null output, empty inventories, malformed JSON, and retrieval failure. A mocked scanner result containing a fixable Critical finding caused the workflow’s release condition to fail. This verifies gate logic; it does not demonstrate Trivy detecting a real vulnerability.

The policy blocks fixable Critical findings. It does not imply that High findings or unfixed Critical findings are acceptable forever. Those need an explicit operational response outside this narrow release condition.

After successful verification, the production workflow promotes the candidate digest with `docker buildx imagetools create`. It does not rebuild for release. An experimental helper adds a post-promotion digest comparison, and a mocked mismatch fails its test. Actual registry promotion remains untested in this environment.

## What the results support

All 12 application and security test cases passed. The application returned its expected JSON response and rejected an unknown route. The following table separates those observations from the container comparison still awaiting execution:

| Check or measurement | Conventional baseline | SIP variant |
| --- | --- | --- |
| Dependency-age enforcement | No additional check | Live lockfile validation passed |
| Installation lifecycle scripts | Enabled by default | Suppression verified with local fixture |
| Missing-SBOM release behavior | No additional gate | Rejection verified with mocked Docker |
| Fixable Critical release behavior | No additional gate | Rejection verified with mocked scanner output |
| Compressed and local image size | Not measured | Not measured |
| Critical, High, Medium and Low image CVEs | Not measured | Not measured |
| Build and complete CI duration | Not measured | Not measured |
| Attached SBOM/provenance availability | Not measured | Not measured |
| Bit-for-bit rebuild reproducibility | Not measured | Not measured |

A separate npm audit reported six dependency vulnerability entries: one Critical, four High, and one Moderate. Those results include development dependencies and are preserved in the evidence bundle. They are not image CVE counts and cannot predict the attached-SBOM gate’s result.

Even a future scan returning zero detected CVEs would describe one scanner, inventory, database, and point in time. It would not establish a vulnerability-free application.

## The review was part of the engineering

[PR #2](https://github.com/ContainerSecurity-dev/sip/pull/2) provides a useful record of how the implementation developed. Qodo identified the lockfile cooldown bypass and weak SBOM retrieval. Copilot independently raised the SBOM issue and flagged npm compatibility, unrestricted manual release refs, and overlapping promotion runs.

The current workflow explicitly validates dependencies, retrieves evidence, restricts manual refs, and cancels superseded runs by ref. Historical successful Actions runs support that implementation history; they are not measurements from this experiment.

Some limits remain. Ref-based cancellation mitigates promotion races but cannot make a registry update transactional. A permitted tag name is not proof of human approval. Docker Sandboxes guidance is useful for local agent isolation, but no sandbox boundary was tested here and no CI isolation claim follows from it.

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

On a Docker-enabled host with Trivy and registry access, run the documented benchmark harness. It alternates variant order, records base and candidate digests, retains scanner output, and separates comparable runtime scans from the attached-SBOM gate. It keeps compressed layer bytes separate from local image size and reports medians only when measurements exist.

The next step is to execute that comparison and measure the overhead. What is already demonstrated is more specific: a release control becomes useful when its failure behavior is observable. Check the dependency artifact, require the evidence, and carry the same image digest through verification and promotion.
