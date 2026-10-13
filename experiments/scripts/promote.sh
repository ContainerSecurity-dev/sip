#!/usr/bin/env bash
set -euo pipefail
: "${IMAGE:?}" "${DIGEST:?}" "${PROMOTION_TAG:?}" "${REF_TYPE:?}" "${REF_NAME:?}"
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
"$root/scripts/validate-release-ref.sh"
[[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
docker buildx imagetools create --tag "${IMAGE}:${PROMOTION_TAG}" "${IMAGE}@${DIGEST}"
actual=$(docker buildx imagetools inspect "${IMAGE}:${PROMOTION_TAG}" --format '{{json .Manifest.Digest}}' | jq -r .)
test "$actual" = "$DIGEST"
