#!/usr/bin/env sh
set -eu

target_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/secrets"
target_file="$target_dir/documenso-cert.p12"
mkdir -p "$target_dir"
if [ -e "$target_file" ]; then
  echo "Certificate already exists at $target_file; leaving it untouched."
  exit 1
fi
printf 'Enter the same strong passphrase you will use for DOCUMENSO_SIGNING_PASSPHRASE: '
stty -echo
IFS= read -r cert_pass
stty echo
printf '\n'
if [ "${#cert_pass}" -lt 12 ]; then
  echo "Use a passphrase of at least 12 characters." >&2
  exit 1
fi
private_key="$target_dir/private.key"
certificate="$target_dir/certificate.crt"
trap 'rm -f "$private_key" "$certificate"' EXIT
openssl genrsa -out "$private_key" 2048
openssl req -new -x509 -key "$private_key" -out "$certificate" -days 825 \
  -subj "/C=IT/O=Villa Tullia/CN=Villa Tullia Signing Certificate"
CERT_PASS="$cert_pass" openssl pkcs12 -export -out "$target_file" -inkey "$private_key" -in "$certificate" \
  -password env:CERT_PASS
chmod 440 "$target_file"
echo "Created $target_file. Keep the passphrase in a password manager and never commit the file."
