#!/usr/bin/env bash
# Generate prisma/schema.prisma from scrum4me-shared canonical.
#
# Bumps the submodule first to get latest shared content,
# then runs gen-consumer-schema.sh (with Prisma-7 URL-strip if needed).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARED="$ROOT/vendor/scrum4me-shared"

if [ ! -f "$SHARED/scripts/gen-consumer-schema.sh" ]; then
  echo "error: shared submodule not initialized — run 'git submodule update --init'" >&2
  exit 1
fi

mkdir -p "$ROOT/prisma"
bash "$ROOT/scripts/gen-schema.sh" > "$ROOT/prisma/schema.prisma"

echo "synced schema from scrum4me-shared@$(cd "$SHARED" && git rev-parse --short HEAD) to prisma/schema.prisma"
