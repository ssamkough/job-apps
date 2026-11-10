#!/usr/bin/env bash
# Dumps the database to ./backups/jobapps-<timestamp>.sql.gz and keeps the
# newest 14. Uses DIRECT_URL (falls back to DATABASE_URL) from the environment
# or .env. Restore with:  gunzip -c backups/<file>.sql.gz | psql "$DIRECT_URL"
# Resume files are NOT included: back up UPLOAD_DIR or your bucket separately.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then set -a; . ./.env; set +a; fi
URL="${DIRECT_URL:-${DATABASE_URL:-}}"
[ -n "$URL" ] || { echo "DIRECT_URL or DATABASE_URL must be set" >&2; exit 1; }

mkdir -p backups
OUT="backups/jobapps-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
pg_dump --no-owner --no-privileges "$URL" | gzip > "$OUT"
echo "Wrote $OUT"
ls -1t backups/jobapps-*.sql.gz | tail -n +15 | xargs -r rm --
