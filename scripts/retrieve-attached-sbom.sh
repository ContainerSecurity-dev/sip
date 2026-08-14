#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE:?IMAGE is required}"
: "${DIGEST:?DIGEST is required}"

docker buildx imagetools inspect \
  "${IMAGE}@${DIGEST}" \
  --format '{{ json .SBOM.SPDX }}' > sbom.spdx.json

jq -e \
  '.spdxVersion and (.packages | type == "array") and (.packages | length > 0)' \
  sbom.spdx.json > /dev/null
