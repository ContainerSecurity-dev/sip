# sip

Demo toy Express.js application written in TypeScript.

## Run locally

```bash
npm ci --ignore-scripts
npm run dev
```

Server starts on `http://localhost:3000` by default.

## Build and run

```bash
npm run build
npm start
```

## Supply-chain release

Pull requests targeting `main` validate the locked dependency set, application
build, and tests in a dedicated SIP ii job. Same-repository pull requests then
run a combined SIP iii–iv job that builds the Docker Hardened Image once and
publishes its SBOM and maximum-provenance attestations, followed by a separate
SIP v Critical-CVE gate. The gate scans the attached SBOM from the immutable
digest and creates or updates a PR comment with its findings. Fork pull requests
never receive DHI or registry credentials.

The release workflow builds from Docker Hardened Images, publishes a commit-SHA
candidate with BuildKit SBOM and maximum provenance attestations, and scans the
candidate by digest after explicitly retrieving its attached OCI SBOM. A successful Critical
vulnerability gate promotes that same digest to `latest` (main) or the release
tag (`v*`); it is never rebuilt between scanning and promotion.

Configure the `DHI_USERNAME` and `DHI_PASSWORD` repository secrets for access to
`dhi.io`. GitHub's `GITHUB_TOKEN` publishes to
`ghcr.io/containersecurity-dev/sip`.

Local AI-agent isolation is a host control. Before running an agent, initialize
Docker Sandboxes with `sbx policy init deny-all`, allow only task-required
destinations, and store Codex OAuth with `sbx secret set openai --oauth`. Never
reset or weaken an existing sandbox policy without reviewing its consumers.
