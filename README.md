# Villa Tullia booking workflow

This repository contains the public Villa Tullia website and a self-hosted enquiry, agreement, signing, and payment application. It is designed to run on the existing Hetzner VPS without a new hosting subscription.

## What is included

- Website enquiries stored in the private application database instead of being sent from browser-side EmailJS code.
- Password-protected administrator dashboard at `/admin` with enquiry and booking lists, filters, draft editing, agreement actions, payment status, signed-document downloads, cancellation, and a complete audit timeline.
- Guarded booking state machine and database-level date-overlap prevention.
- Expiring date holds from the moment an agreement is sent.
- Versioned Handlebars agreement template, immutable generated PDFs, SHA-256 hashes, preview, and restricted downloads.
- Swappable signing providers: safe local mock and self-hosted Documenso Community Edition.
- Swappable payment providers: safe local mock and Stripe Checkout in test mode.
- Verified, idempotent Documenso and Stripe webhooks.
- Secure, random guest status links with no guest account requirement.
- Reusable email templates, local email previews, SMTP delivery, reminders, and expiry jobs.
- Docker, Caddy HTTPS, PostgreSQL for Documenso, backup scripts, and Hetzner-ready configuration.

## Cost boundary

The application, SQLite database, Caddy, PostgreSQL, and Documenso Community Edition are open source and can run on the VPS already being paid for. Caddy obtains normal TLS certificates at no additional cost.

There are three practical limits to “free”:

1. Stripe test mode is free. Real card payments always incur Stripe's transaction fees; the application intentionally refuses non-test Stripe keys until live activation is changed deliberately.
2. Outbound mail needs an SMTP account. An existing domain mailbox, Gmail app password, or a suitable free tier can be used without a new server charge. Running a new public mail server on the VPS is deliberately avoided because delivery reputation is unreliable.
3. The included free self-signed Documenso certificate supports cryptographic sealing and ordinary electronic signatures, but is not a paid EU qualified electronic signature or an Adobe trusted-list certificate. Obtain legal advice if a higher signature level is required.

## Booking states and date blocking

The application permits only explicit state transitions:

`AGREEMENT_DRAFT` → `AWAITING_OWNER_SIGNATURE` → `AWAITING_GUEST_SIGNATURE` → `AGREEMENT_SIGNED` → `AWAITING_PAYMENT` → `PAYMENT_PROCESSING` or `CONFIRMED`.

Failure, cancellation, expiry, and refund transitions are guarded separately. Invalid jumps—such as creating payment before both signatures—raise an error.

The following states block dates: `AWAITING_OWNER_SIGNATURE`, `AWAITING_GUEST_SIGNATURE`, `AGREEMENT_SIGNED`, `AWAITING_PAYMENT`, `PAYMENT_PROCESSING`, `PAYMENT_FAILED`, and `CONFIRMED`. Pre-signature blocks are holds with a configurable expiry. `AGREEMENT_DRAFT`, `EXPIRED`, `CANCELLED`, and `REFUNDED` do not block dates.

SQLite triggers reject overlapping active holds or confirmed bookings even if application validation is bypassed.

## Local test setup

Requires Node.js 24 and pnpm 11.

1. Copy `.env.example` to `.env` and keep the mock/preview providers enabled.
2. Replace `COOKIE_SECRET` with a random value of at least 32 characters.
3. Install and prepare the database:

   ```sh
   pnpm install
   pnpm db:migrate
   ```

4. Create the administrator without putting the password in source control:

   ```sh
   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-unique-password' ADMIN_NAME='Your Name' pnpm admin:create
   ```

5. Start the application and open `http://127.0.0.1:3000`:

   ```sh
   pnpm dev
   ```

Local emails are written to `storage/email-preview`. Mock signing and payment buttons are visible only while the corresponding mock provider is enabled.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
```

The tests cover status guards, date blocking, immutable agreement versions, the two-signature gate, payment confirmation idempotency, public form validation, spam honeypot behavior, static-file allowlisting, and private-file denial.

## Hetzner VPS deployment

The VPS should have a current Linux distribution, Docker Engine, Docker Compose v2, and at least 2 GB of available RAM for the full Documenso stack.

1. Point `villatullia.it`, `www.villatullia.it`, and `sign.villatullia.it` DNS records to the VPS.
2. Copy the project to the VPS.
3. Copy `deploy/.env.production.example` to `.env.production`, replace every placeholder, and restrict it with `chmod 600 .env.production`.
4. Create the free local Documenso signing certificate:

   ```sh
   chmod +x deploy/generate-signing-certificate.sh deploy/backup.sh
   ./deploy/generate-signing-certificate.sh
   sudo chown 1001:1001 deploy/secrets/documenso-cert.p12
   sudo chmod 400 deploy/secrets/documenso-cert.p12
   ```

5. Build and start the stack:

   ```sh
   docker compose --env-file .env.production up -d --build
   ```

6. Create the Villa administrator inside the running app:

   ```sh
   docker compose --env-file .env.production exec \
     -e ADMIN_EMAIL='you@example.com' \
     -e ADMIN_PASSWORD='a-long-unique-password' \
     -e ADMIN_NAME='Your Name' app node dist/scripts/create-admin.js
   ```

7. Open `https://sign.villatullia.it`, create the first Documenso account, then disable public signup by changing `DOCUMENSO_DISABLE_SIGNUP=true` and restarting the stack.
8. In Documenso, create an API token and a team webhook for `DOCUMENT_SIGNED`, `DOCUMENT_RECIPIENT_COMPLETED`, and `DOCUMENT_COMPLETED`. Use `https://villatullia.it/webhooks/documenso` and the same secret placed in `DOCUMENSO_WEBHOOK_SECRET`.
9. Put the API token in `.env.production`, change `SIGNING_PROVIDER=documenso`, and restart.

Caddy automatically serves HTTPS once DNS resolves and ports 80 and 443 are open. If the VPS already uses those ports, the existing reverse proxy must be extended instead of starting the bundled Caddy service.

### Existing Nginx VPS

The current Hetzner server already uses Nginx for another site. Keep that site and `/var/www/html` unchanged, and run only the application services with the Nginx override:

```sh
docker compose -f compose.yml -f deploy/compose.nginx.yml --env-file .env.production up -d --build app documenso documenso_database mailpit
```

This binds the villa application, Documenso, and the temporary email-preview inbox only to loopback ports `3100`, `3101`, and `3102`. Install `deploy/nginx-villatullia-http.conf` as a new Nginx site, test the Nginx configuration, and reload it. Do not copy the bundled Caddy configuration or publish its ports on this server.

The Mailpit inbox is for staged testing only and is not publicly exposed. Replace its SMTP settings with an existing mailbox or suitable free SMTP service before inviting real guests.

## Stripe activation

Keep `PAYMENT_PROVIDER=mock` until signing has been tested. Then:

1. Create Stripe test-mode credentials.
2. Create a webhook at `https://villatullia.it/webhooks/stripe` for:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `payment_intent.payment_failed`
   - `charge.refunded`
3. Put the `sk_test_...` key and `whsec_...` webhook secret in `.env.production`.
4. Change `PAYMENT_PROVIDER=stripe` and restart.

Opening the Stripe success page never confirms a booking. Only a verified Stripe webhook can do that. Prices and metadata are loaded from the database, not from browser input.

The current build intentionally accepts only `sk_test_` keys. Enabling real card payments later requires a deliberate code/configuration change and acceptance of Stripe's unavoidable transaction fees.

## Backups and operations

Create a consistent SQLite backup, Documenso PostgreSQL dump, signed-document archive, and signing-certificate copy with:

```sh
./deploy/backup.sh
```

Backups contain personal and contractual data. Copy them off the VPS, encrypt them, and remove old copies under an appropriate retention policy. A same-server backup does not protect against VPS loss.

Run the reminder/expiry worker continuously through the main server process (already configured), or manually with `pnpm jobs`. Check health at `/healthz` and review container logs after upgrades. Pin and test new Documenso versions before changing `DOCUMENSO_VERSION`.

## Before going live

- Replace all owner, property, sender, and legal-address placeholders.
- Have the agreement, cancellation language, tourist-tax treatment, privacy notice, retention policy, and required signature level reviewed for the actual Italian rental arrangement.
- Confirm the SMTP sender can deliver to external recipients.
- Test owner-first sequential signing, webhook delivery, signed PDF download, Stripe test success/failure/refund events, hold expiry, cancellation, backups, and restoration.
- Never commit `.env`, `.env.production`, databases, generated agreements, email previews, backups, or `deploy/secrets`.

## Main implementation locations

- Database migration: `migrations/001_initial.sql`
- Status rules: `src/domain/status.ts`
- Admin and public routes: `src/routes/`
- Agreement generator/template: `src/services/agreement.ts` and `templates/agreements/v1.hbs`
- Signing and payment adapters: `src/services/signature.ts` and `src/services/payment.ts`
- Email templates: `src/views/emails/`
- VPS stack: `compose.yml`, `Dockerfile`, and `deploy/`
