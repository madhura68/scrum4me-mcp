#!/usr/bin/env bash
# Update de host-side stdio-MCP-clone (de "operator-MCP"; draait `npm start` =
# tsx src/index.ts). Draai DIT script i.p.v. een kale `git pull`.
#
# Achtergrond: deze host-clone wordt NIET door de agent-runner-images gebruikt
# (die klonen scrum4me-mcp vers uit Forgejo bij de image-build) en wordt NIET
# door de update_*_worker-flows bijgewerkt — hij moet handmatig bij.
#
# Waarom de submodule ALTIJD mee moet: prisma/schema.prisma wordt GEGENEREERD uit
# vendor/scrum4me-shared (scripts/gen-schema.sh). Een kale `git pull` verzet de
# geregistreerde submodule-pointer wél maar checkt de submodule-werkboom NIET uit,
# waardoor:
#   1. de working tree dirty raakt (` M vendor/scrum4me-shared`), en
#   2. een daaropvolgende `prisma:generate` het schema uit de OUDE shared bouwt
#      -> stille schema-drift.
# --recurse-submodules + een expliciete `git submodule update` dekken dat af,
# onafhankelijk van lokale git-config (overleeft dus een re-clone).
#
# NA afloop: herstart/reconnect de stdio-MCP-client handmatig — er is GEEN
# hot-reload; een draaiend tsx-proces blijft op de oude code tot het herstart.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo-root

echo "==> git pull --ff-only --recurse-submodules"
git pull --ff-only --recurse-submodules

echo "==> git submodule update --init --recursive (idempotent; borgt de sync)"
git submodule update --init --recursive

# Draai handmatig `npm ci` als package.json/package-lock veranderde (zeldzaam bij
# een submodule-bump; de meeste updates zijn schema-only).
echo "==> npm run prisma:generate (schema uit de verse vendor/scrum4me-shared + prisma client)"
npm run prisma:generate

echo "==> KLAAR."
echo "    LET OP: herstart/reconnect de stdio-MCP-client — geen hot-reload."
