# Sourced by backup.sh and restore-test.sh (and backup-lib.test.sh). Needs
# PASSFILE set to the passphrase file.
#
# AES-256-CBC gives confidentiality, not integrity: a byte flipped in a
# ciphertext decrypts to garbage that `pg_restore` or `tar` may half-apply
# without complaint (audit I1). So every `.enc` gets an HMAC-SHA256 beside it
# (`<file>.hmac`), and a restore verifies it BEFORE anything is decrypted.
# The MAC key is derived from the passphrase under its own label, so it is
# not the encryption passphrase and the two uses never share a key.

encrypt() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$PASSFILE"; }
decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$PASSFILE"; }

# The 32-byte MAC key, hex: sha256("pactora-backup-mac-v1:" + passphrase bytes).
mac_key() {
  { printf 'pactora-backup-mac-v1:'; cat "$PASSFILE"; } | openssl dgst -sha256 -r | cut -d' ' -f1
}

# HMAC-SHA256 of a file, hex.
hmac_of() {
  openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(mac_key)" -r "$1" | cut -d' ' -f1
}

# Write `<file>.hmac` beside the file.
write_hmac() {
  hmac_of "$1" > "$1.hmac"
  chmod 600 "$1.hmac"
}

# Succeeds only when `<file>.hmac` exists and matches the file as it is now.
verify_hmac() {
  local file="$1" want have
  [ -s "$file.hmac" ] || return 1
  want="$(tr -d '[:space:]' < "$file.hmac")"
  have="$(hmac_of "$file")"
  [ -n "$have" ] && [ "$want" = "$have" ]
}
