#!/usr/bin/env sh
set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

if [ ! -f .env.production ]; then
  echo '.env.production is missing' >&2
  exit 1
fi

IFS= read -r telegram_bot_token
IFS= read -r telegram_chat_id
IFS= read -r telegram_webhook_secret

if [ -z "$telegram_bot_token" ] || [ -z "$telegram_chat_id" ] || [ -z "$telegram_webhook_secret" ]; then
  echo 'Telegram configuration is incomplete' >&2
  exit 1
fi

temporary_file="$(mktemp "$project_dir/.env.production.telegram.XXXXXX")"
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM

grep -v '^TELEGRAM_BOT_TOKEN=' .env.production |
  grep -v '^TELEGRAM_CHAT_ID=' |
  grep -v '^TELEGRAM_WEBHOOK_SECRET=' > "$temporary_file"

{
  printf '\nTELEGRAM_BOT_TOKEN=%s\n' "$telegram_bot_token"
  printf 'TELEGRAM_CHAT_ID=%s\n' "$telegram_chat_id"
  printf 'TELEGRAM_WEBHOOK_SECRET=%s\n' "$telegram_webhook_secret"
} >> "$temporary_file"

chmod 600 "$temporary_file"
mv "$temporary_file" .env.production
trap - EXIT HUP INT TERM

docker compose -f compose.yml -f deploy/compose.nginx.yml --env-file .env.production up -d --no-deps --force-recreate app

attempt=0
until curl --fail --silent --show-error http://127.0.0.1:3100/healthz >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'Application did not recover after Telegram configuration' >&2
    exit 1
  fi
  sleep 2
done

echo 'Telegram production configuration applied.'
