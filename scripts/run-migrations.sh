#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required to run migrations"
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql client is required to run migrations"
  exit 1
fi

shopt -s nullglob
files=(db/migrations/*.sql)
shopt -u nullglob

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No SQL migration files found in db/migrations"
  exit 0
fi

for file in "${files[@]}"; do
  echo "Applying migration: ${file}"
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${file}"
done

echo "Migrations completed"
