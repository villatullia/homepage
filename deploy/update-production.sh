#!/usr/bin/env sh
set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

if [ ! -f .env.production ]; then
  echo '.env.production is missing' >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Tracked server files have local changes; deployment stopped.' >&2
  exit 1
fi

exec 9>"$project_dir/.deploy.lock"
if ! flock -n 9; then
  echo 'Another deployment is already running.' >&2
  exit 1
fi

sh ./deploy/backup.sh
git fetch origin main
git checkout main
git merge --ff-only origin/main

compose() {
  docker compose -f compose.yml -f deploy/compose.nginx.yml --env-file .env.production "$@"
}

compose build app
compose up -d --no-deps app

attempt=0
until curl --fail --silent --show-error http://127.0.0.1:3100/healthz >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    compose logs --tail=100 app
    echo 'Production health check failed.' >&2
    exit 1
  fi
  sleep 2
done

echo "Deployed $(git rev-parse --short HEAD) successfully."
