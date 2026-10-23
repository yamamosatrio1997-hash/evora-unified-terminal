#!/bin/sh
# Creates a separate database and role for n8n on first initialization only.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE n8n LOGIN PASSWORD '${N8N_DB_PASSWORD}';
CREATE DATABASE n8n OWNER n8n;
SQL
