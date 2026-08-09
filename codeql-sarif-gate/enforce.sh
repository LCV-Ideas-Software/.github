#!/usr/bin/env bash
set -euo pipefail

sarif_directory="${SARIF_DIRECTORY_INPUT:-${CODEQL_RESULTS:-}}"
if [ -z "$sarif_directory" ]; then
  echo "::error::A SARIF directory is required through sarif-directory or CODEQL_RESULTS." >&2
  exit 1
fi
if [ ! -d "$sarif_directory" ]; then
  echo "::error::The SARIF directory does not exist: $sarif_directory" >&2
  exit 1
fi

sarif_list="$(mktemp)"
cleanup() {
  rm -f "$sarif_list"
}
trap cleanup EXIT

if ! find "$sarif_directory" -type f -name '*.sarif' -print0 >"$sarif_list"; then
  echo "::error::Could not enumerate every SARIF file." >&2
  exit 1
fi

finding_inventory='[]'
finding_count=0
sarif_file_count=0
while IFS= read -r -d '' sarif_file; do
  sarif_file_count="$((sarif_file_count + 1))"
  file_inventory="$(
    jq -ce -s -f "$GITHUB_ACTION_PATH/policy.jq" "$sarif_file"
  )"
  file_count="$(jq -er 'length' <<<"$file_inventory")"
  finding_count="$((finding_count + file_count))"
  finding_inventory="$(
    jq -cen \
      --argjson prior "$finding_inventory" \
      --argjson current "$file_inventory" \
      '$prior + $current'
  )"
done <"$sarif_list"

if [ "$sarif_file_count" -eq 0 ]; then
  echo "::error::CodeQL produced no SARIF file to enforce." >&2
  exit 1
fi

if [ "$finding_count" -ne 0 ]; then
  echo "::error::CodeQL reported $finding_count SARIF result(s); zero are allowed. Inventory: $finding_inventory" >&2
  exit 1
fi
echo "CodeQL reported zero SARIF results."
