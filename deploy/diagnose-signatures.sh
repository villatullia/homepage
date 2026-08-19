#!/usr/bin/env sh
set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$project_dir"

compose() {
  docker compose -f compose.yml -f deploy/compose.nginx.yml --env-file .env.production "$@"
}

echo 'Villa booking signature state (latest five)'
compose exec -T app node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync("/app/data/private/villa.sqlite", { readOnly: true });
  console.log(db.prepare(`
    SELECT b.reference, b.status AS booking_status, a.status AS agreement_status,
           a.provider_document_id, a.owner_signed_at, a.guest_signed_at,
           a.completed_at
    FROM bookings b
    JOIN agreements a ON a.booking_id = b.id
    WHERE a.status IN (?, ?, ?)
    ORDER BY a.updated_at DESC LIMIT 5
  `).all("SENT", "OWNER_SIGNED", "COMPLETED"));
  console.log(db.prepare(`
    SELECT event_type, processing_error, received_at, processed_at
    FROM webhook_events WHERE provider = ?
    ORDER BY received_at DESC LIMIT 10
  `).all("documenso"));
'

echo 'Documenso envelope and recipient state (latest five envelopes)'
compose exec -T documenso_database psql -U documenso -d documenso -P pager=off -c '
  SELECT e.id, e.status, e."completedAt", r."signingOrder", r."signingStatus", r."signedAt"
  FROM "Envelope" e
  JOIN "Recipient" r ON r."envelopeId" = e.id
  ORDER BY e."updatedAt" DESC, r."signingOrder" ASC
  LIMIT 10;
'

echo 'Recent Documenso signing/sealing errors'
compose logs --since=2h --no-color documenso \
  | grep -Ei 'error|failed|seal|certificate|signing' \
  | tail -n 120 || true
