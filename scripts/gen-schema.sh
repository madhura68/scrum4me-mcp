#!/usr/bin/env bash
# Wrapper around scrum4me-shared's gen-consumer-schema.sh that strips
# url= / directUrl= lines from the datasource block. scrum4me-mcp reads
# DATABASE_URL from env at runtime via the Prisma client — schema-level
# URL refs aren't needed and conflict with the simpler datasource pattern.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SHARED="$ROOT/vendor/scrum4me-shared"

bash "$SHARED/scripts/gen-consumer-schema.sh" \
  | sed -E '/^[[:space:]]+(url|directUrl)[[:space:]]*=/d'
