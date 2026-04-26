#!/usr/bin/env bash
# Sync prisma/schema.prisma from the vendored Scrum4Me submodule.
#
# Strips the `generator erd` block — that generator depends on
# prisma-erd-generator which we don't ship in this MCP package. The
# schema is otherwise byte-identical with upstream.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/vendor/scrum4me/prisma/schema.prisma"
DST="$ROOT/prisma/schema.prisma"

if [ ! -f "$SRC" ]; then
  echo "error: $SRC not found — run 'git submodule update --init' first" >&2
  exit 1
fi

mkdir -p "$ROOT/prisma"

# Strip the `generator erd { ... }` block (multi-line, balanced braces).
awk '
  /^generator erd \{/ { skip = 1; next }
  skip && /^\}/ { skip = 0; next }
  skip { next }
  { print }
' "$SRC" > "$DST"

echo "synced schema from $(cd "$ROOT/vendor/scrum4me" && git rev-parse --short HEAD) to prisma/schema.prisma"
