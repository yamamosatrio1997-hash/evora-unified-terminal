#!/usr/bin/env bash
# Daily logical backup of both databases with 14-day retention.
# Cron example: 15 2 * * * /opt/tcc/deploy/backup.sh >> /var/log/tcc-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
OUT="${BACKUP_DIR:-./backups}"
mkdir -p "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
for db in "${POSTGRES_DB:-tcc}" n8n; do
  docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-tcc}" -d "$db" --format=custom --no-owner > "$OUT/${db}_${STAMP}.dump"
  # verify the archive is readable before trusting it
  docker compose exec -T postgres pg_restore --list < "$OUT/${db}_${STAMP}.dump" > /dev/null
done
find "$OUT" -name '*.dump' -mtime +14 -delete
echo "backup ok: $STAMP"
