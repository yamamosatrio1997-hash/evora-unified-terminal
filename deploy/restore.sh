#!/usr/bin/env bash
# Restore one database from a pg_dump custom archive. Stops the app first.
# Usage: deploy/restore.sh tcc backups/tcc_20260101T021500Z.dump
set -euo pipefail
cd "$(dirname "$0")/.."
DB="$1"; FILE="$2"
set -a; . ./.env; set +a
read -r -p "This replaces database '$DB'. Type the database name to confirm: " CONFIRM
[ "$CONFIRM" = "$DB" ] || { echo "aborted"; exit 1; }
docker compose stop backend n8n
docker compose exec -T postgres dropdb -U "${POSTGRES_USER:-tcc}" --if-exists "$DB"
docker compose exec -T postgres createdb -U "${POSTGRES_USER:-tcc}" -O "$( [ "$DB" = n8n ] && echo n8n || echo "${POSTGRES_USER:-tcc}")" "$DB"
docker compose exec -T postgres pg_restore -U "${POSTGRES_USER:-tcc}" -d "$DB" --no-owner --role="$( [ "$DB" = n8n ] && echo n8n || echo "${POSTGRES_USER:-tcc}")" < "$FILE"
docker compose start backend n8n
echo "restored $DB from $FILE"
