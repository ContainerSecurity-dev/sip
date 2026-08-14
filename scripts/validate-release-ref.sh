#!/usr/bin/env bash
set -euo pipefail

if [[ "${REF_TYPE}" == "branch" && "${REF_NAME}" == "main" ]]; then
  exit 0
fi

if [[ "${REF_TYPE}" == "tag" && "${REF_NAME}" == v* ]]; then
  exit 0
fi

echo "Ref ${REF_TYPE}:${REF_NAME} is not eligible for release" >&2
exit 1
