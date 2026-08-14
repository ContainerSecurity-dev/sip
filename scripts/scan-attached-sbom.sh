#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

trivy sbom \
  --scanners vuln \
  --severity CRITICAL \
  --ignore-unfixed \
  --exit-code 0 \
  --format json \
  --output trivy.json \
  sbom.spdx.json

critical_count=$(jq '[.Results[]?.Vulnerabilities[]?] | length' trivy.json)
echo "critical-count=${critical_count}" >> "${GITHUB_OUTPUT}"
