#!/usr/bin/env bash
# Regenerate container/agent-runner/src/schemas/matclaw_v2.ts from the
# vendored matclaw_v2.py and fail if it differs from the committed file.
#
# Beads: beefcake-bde2x (P0.2). Design: matclaw-v2-roadmap.md §2.
#
# Requirements:
#   - Python 3.11+ with `pydantic-to-typescript` installed.
#   - node_modules/.bin/json2ts available (npm install in
#     container/agent-runner/ provides this via json-schema-to-typescript).
#
# Usage:
#   scripts/check-schema-sync.sh            # CI mode: exit 1 on drift
#   scripts/check-schema-sync.sh --regen    # Local dev: overwrite the .ts
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER_DIR="$REPO_ROOT/container/agent-runner"
SCHEMA_DIR="$RUNNER_DIR/src/schemas"
PY_FILE="$SCHEMA_DIR/matclaw_v2.py"
TS_FILE="$SCHEMA_DIR/matclaw_v2.ts"
JSON2TS="$RUNNER_DIR/node_modules/.bin/json2ts"

if [[ ! -f "$PY_FILE" ]]; then
  echo "ERROR: $PY_FILE not found" >&2
  exit 2
fi
if [[ ! -x "$JSON2TS" ]]; then
  echo "ERROR: $JSON2TS not found — run 'npm install' in $RUNNER_DIR" >&2
  exit 2
fi

PYDANTIC2TS="$(command -v pydantic2ts || true)"
if [[ -z "$PYDANTIC2TS" ]]; then
  echo "ERROR: pydantic2ts not on PATH — pip install pydantic-to-typescript" >&2
  exit 2
fi

regen_mode="check"
if [[ "${1:-}" == "--regen" ]]; then
  regen_mode="regen"
fi

# Generate to a temp directory so we never clobber the committed file
# during a check.
TMPDIR_LOCAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT

# pydantic2ts imports the module — put the schema dir on PYTHONPATH and
# reference the file as a top-level module name (the file's parent
# directory acts as the package root for this purpose).
PYTHONPATH="$SCHEMA_DIR" PATH="$RUNNER_DIR/node_modules/.bin:$PATH" \
  "$PYDANTIC2TS" \
    --module matclaw_v2 \
    --output "$TMPDIR_LOCAL/matclaw_v2.ts" \
  >/dev/null

if [[ "$regen_mode" == "regen" ]]; then
  cp "$TMPDIR_LOCAL/matclaw_v2.ts" "$TS_FILE"
  echo "Regenerated $TS_FILE"
  exit 0
fi

if ! diff -q "$TS_FILE" "$TMPDIR_LOCAL/matclaw_v2.ts" >/dev/null; then
  echo "ERROR: matclaw_v2.ts drift detected." >&2
  echo "       The committed TS file does not match what pydantic2ts" >&2
  echo "       would generate from the current matclaw_v2.py." >&2
  echo "" >&2
  echo "Diff (committed -> regenerated):" >&2
  diff -u "$TS_FILE" "$TMPDIR_LOCAL/matclaw_v2.ts" >&2 || true
  echo "" >&2
  echo "To fix locally: scripts/check-schema-sync.sh --regen" >&2
  exit 1
fi

echo "matclaw_v2.ts is in sync with matclaw_v2.py"
