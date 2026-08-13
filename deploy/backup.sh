#!/usr/bin/env sh
set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"
mkdir -p backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
compose() {
  docker compose -f compose.yml -f deploy/compose.nginx.yml --env-file .env.production "$@"
}
compose exec -T -e BACKUP_PATH=/app/backups app node dist/scripts/backup.js
docker run --rm -v villa-tullia_app_backups:/source:ro -v "$project_dir/backups:/backup" alpine:3.21 \
  sh -c 'cp -a /source/. /backup/'
compose exec -T documenso_database pg_dump -U documenso -F c documenso > "backups/documenso-$stamp.dump"
docker run --rm -v villa-tullia_app_storage:/source:ro -v "$project_dir/backups:/backup" alpine:3.21 \
  tar -czf "/backup/app-storage-$stamp.tar.gz" -C /source .
cp deploy/secrets/documenso-cert.p12 "backups/documenso-cert-$stamp.p12"
find "$project_dir/backups" -type f -mtime +30 -delete
echo "Backup set created in $project_dir/backups. Copy it off the VPS and protect it because it contains personal data."
