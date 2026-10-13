# Reproducing the Node.js SIP case study

Use branch `case-study/node-sip-benchmark`, repository root as your working
directory. Read `docs/sip-benchmark-report.md` for measurement definitions and
`docs/docker-blog-draft.md` for the editorial entry.

## Application and controlled negative tests

Requirements: Node/npm, bash and jq. The recorded final test run uses Node
26.3.0/npm 11.16.0; Node 22.22.3/npm 11.14.1 also passed.

```bash
node scripts/validate-lockfile-age.mjs
npm ci --ignore-scripts
npm test
npm run lint
```

`lint` checks JavaScript/shell syntax, not style. Lifecycle tests use an offline
local tarball that writes a harmless marker. The positive control deliberately
enables its hook inside a temporary directory. No malicious package is used.

To supply the exact Node version and jq in a separate test-only container:

```bash
docker build -t sip-benchmark-test-tools experiments/testing
repo_dir=$(pwd -P)
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$repo_dir,dst=/work" -w /work \
  sip-benchmark-test-tools sh -c 'npm test && npm run lint'
```

The host checkout must already contain the installed dependencies. Keep the
checkout in a Docker Desktop shared directory; this installation could mount
the home directory but could not mount the host `/tmp` checkout.

## Container benchmark

Requirements: running Docker daemon, Buildx, jq, Node/npm, DHI read access and
registry access. Trivy is run as a **digest-pinned container**, so no host Trivy
installation is needed. Authenticate with `docker login dhi.io` if required.
The recorded DHI anonymous metadata request returned 401; existing authenticated
Buildx access worked. Do not put tokens in arguments, logs or committed files.

The measured run used a disposable local registry. Confirm port 5000 and the
container name are available before starting it:

```bash
docker run -d --name sip-benchmark-registry \
  -p 127.0.0.1:5000:5000 registry:2
BENCHMARK_IMAGE=localhost:5000/sip-benchmark \
  TRIVY_NETWORK=container:sip-benchmark-registry \
  REPETITIONS=3 node experiments/scripts/benchmark.mjs
```

The Trivy container shares the disposable registry's network namespace so its
`localhost:5000` reference resolves to the same registry. It does not receive
the host Docker socket or credential store. For a remote registry, use a
separate test repository and omit `TRIVY_NETWORK` (default `bridge`); private
registry authentication for the scanner needs separate secure configuration.
The recorded local path requires no registry credentials.

The default Trivy cache is a sibling `sip-benchmark-trivy-cache` directory,
outside the Git checkout. Override it with `TRIVY_CACHE_DIR` if needed; it must
also be Docker-shareable. `RESULTS_DIR` selects the evidence directory.
`TRIVY_IMAGE` can override the default image but must be recorded/pinned for a
comparable run. Default is Trivy 0.72.0 at digest
`sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f`.

The harness resolves and records base digests, freezes the vulnerability DB
snapshot, alternates variant order, disables Dockerfile cache reuse, and pushes
unique candidate tags. It probes application behavior and scans both runtime
images, then separately retrieves/scans the hardened attached SBOM. A failed
security gate is recorded; no candidate is promoted by this harness.
A completed measurement run can therefore correctly contain failed gates.

Both variants copy the same application and lockfile. Baseline deliberately
uses a conventional multi-stage `node:26.3.0-trixie-slim` image and `npm ci`,
without `.npmrc`, age validation, attestations or release gates. Hardened mirrors
the root Dockerfile, adding build/runtime image ARGs for immutable pinning.
It validates dependencies before building. A standalone Dockerfile invocation
alone does not enforce publication age. Keep this experimental copy aligned
with the reference when the reference changes.

### Measurement definitions

- Build seconds include registry push and, for SIP, SBOM/provenance generation.
- Base downloads, network and host caches are not reset by `--no-cache`.
- Compressed size sums platform runtime-layer descriptor bytes; it excludes
  config, indexes and attestations. Local size is Docker's `.Size`, not unpacked
  size or incremental disk cost. Blog MB uses decimal units.
- Runtime CVE counts include unfixed findings and count occurrences, not distinct
  CVE identifiers. Attached-SBOM gate results are reported separately.
- Security verification timing covers attached-SBOM retrieval and the scan;
  lockfile validation has its own duration. DB download is outside scan timing.
- Local harness duration is not complete GitHub Actions pipeline duration.
- Compare recorded rebuild digests; a lockfile does not guarantee byte identity.

The completed run is `experiments/results/docker-run-2/`. Its harness snapshot
and source hashes preserve exactly what was measured. Earlier failed preflights
are retained separately. Large raw logs/JSON can be losslessly compressed:

```bash
node experiments/scripts/archive-results.mjs experiments/results/docker-run-2
gzip -dc experiments/results/docker-run-2/hardened-1/sbom.json.gz
```

Run `node experiments/scripts/verify-results.mjs experiments/results/docker-run-2`
to cross-check counts, gates and medians against the raw reports.
Compression is optional and does not change measurement values. Raw evidence
under `.gz` remains ordinary JSON/text after decompression.

## Promotion and full CI timing

The measured SIP candidates failed the real Critical gate; **do not promote
them**. `experiments/scripts/promote.sh` is an experimental helper for a future
candidate that has already passed its attached-SBOM gate. It checks eligible
refs, copies the exact digest, and compares the destination tag afterward. It
does not authenticate organizational approval, replace the gate, or make mutable
tags transactional. Production workflow behavior is unchanged.

Complete hosted CI duration remains **Not measured**: no fresh hosted workflow
was dispatched. To measure it, run matched isolated baseline/SIP workflows on
identical runners in a disposable test repository with appropriate DHI access,
then export each run and jobs (define whether approvals/queue time count):

```bash
gh api repos/OWNER/REPO/actions/runs/RUN_ID > run.json
gh api repos/OWNER/REPO/actions/runs/RUN_ID/jobs > jobs.json
```

Do not substitute historical elapsed times or the local harness duration.

## Docker Sandboxes boundaries

`sbx` 0.48.0 was tested with no workspace mounts or shared skills. On a dedicated
unused test installation, initialize the intended network policy first:

```bash
sbx policy init deny-all
experiments/scripts/sandbox-probes.sh
```

`policy init` affects the installation's global policy. Do not reset a user's
existing policy to reproduce this test. The script creates/removes only its own
sandbox and does not change policy. It verifies host-file/environment exclusion,
sandbox-write isolation and a denied HTTPS request corroborated by the proxy
policy log. It does not run an AI agent, test all escape paths, or establish CI
sandboxing. Original observations are in `results/sandbox/`; the reusable script's
run is in `results/sandbox-script-run/`.

After collecting evidence, clean up only the experiment's registry:

```bash
docker rm -f sip-benchmark-registry
```

This discards that registry's temporary image storage. Source, raw evidence and
locally pulled images remain available. Do not run global prune/reset commands.
