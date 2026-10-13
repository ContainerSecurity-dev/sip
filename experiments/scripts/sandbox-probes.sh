#!/usr/bin/env bash
set -euo pipefail
# Prerequisite: initialize deny-all policy on an unused test installation.
# This script does not change global policy or touch existing sandboxes.
name="sip-boundary-$$"
results="${SANDBOX_RESULTS:-experiments/results/sandbox-reproduction}"
mkdir -p "$results"
sentinel=$(mktemp /tmp/sip-host-marker.XXXXXX)
printf 'harmless-host-marker\n' > "$sentinel"
cleanup() { sbx rm --force "$name" >/dev/null 2>&1 || true; rm -f "$sentinel"; }
trap cleanup EXIT
sbx version > "$results/version.txt"
sbx create --name "$name" --skills off shell > "$results/create.txt" 2>&1
SIP_HOST_ONLY_SENTINEL=test-only sbx exec "$name" sh -c '
  test ! -r "$1"
  test -z "${SIP_HOST_ONLY_SENTINEL:-}"
  printf isolated > "$1.sandbox"
  test "$(cat "$1.sandbox")" = isolated
  code=$(curl --silent --show-error --max-time 10 --output /tmp/probe-body --write-out "%{http_code}" https://example.com)
  test "$code" = 403
  printf "host-file=inaccessible\nhost-env=not-inherited\nsandbox-file=writable\nnetwork-http=%s\n" "$code"
' sh "$sentinel" > "$results/probes.txt" 2>&1
test ! -e "$sentinel.sandbox"
sbx policy log "$name" --json > "$results/policy-log.json"
jq -e '.blocked[] | select(.host == "example.com:443")' "$results/policy-log.json" >/dev/null
printf 'host-write-isolation=pass\nnetwork-policy-corroboration=pass\n' >> "$results/probes.txt"
