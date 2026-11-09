#!/usr/bin/env bash
# The backup integrity check (audit I1), exercised without a server: a file
# is encrypted and MAC'd the way backup.sh does it; the MAC verifies; one
# flipped ciphertext byte, a missing .hmac and another passphrase each fail
# the way restore-test.sh would stop. Run: bash deploy/vps/backup-lib.test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

PASSFILE="$work/pass"
openssl rand -base64 32 > "$PASSFILE"
# Git Bash on Windows: openssl is a native binary and `-pass file:/tmp/...`
# is not path-converted, so hand it a Windows path there.
if command -v cygpath > /dev/null 2>&1; then PASSFILE="$(cygpath -m "$PASSFILE")"; fi
# shellcheck source=backup-lib.sh
. "$here/backup-lib.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0
ok() { pass=$((pass + 1)); echo "ok   $*"; }

printf 'the database, as pg_dump wrote it\n%s\n' "$(head -c 4096 /dev/urandom | base64)" > "$work/dump"
encrypt < "$work/dump" > "$work/dump.enc"
write_hmac "$work/dump.enc"

# 1. Intact: the MAC verifies and the file decrypts to what went in.
verify_hmac "$work/dump.enc" || fail "an intact backup did not verify"
cmp -s "$work/dump" <(decrypt < "$work/dump.enc") || fail "an intact backup did not decrypt"
ok "intact backup verifies and decrypts"

# 2. One flipped byte in the ciphertext body: the MAC must fail BEFORE a
#    decrypt (which, with CBC, could still produce plausible output).
cp "$work/dump.enc" "$work/tampered.enc"
cp "$work/dump.enc.hmac" "$work/tampered.enc.hmac"
size=$(stat -c %s "$work/tampered.enc" 2>/dev/null || stat -f %z "$work/tampered.enc")
offset=$((size / 2))
byte=$(dd if="$work/tampered.enc" bs=1 skip="$offset" count=1 2>/dev/null | od -An -tu1 | tr -d ' ')
printf "\\$(printf '%03o' $(((byte ^ 1) & 255)))" | dd of="$work/tampered.enc" bs=1 seek="$offset" count=1 conv=notrunc 2>/dev/null
cmp -s "$work/dump.enc" "$work/tampered.enc" && fail "the byte was not flipped"
if verify_hmac "$work/tampered.enc"; then fail "a tampered backup verified"; fi
ok "a flipped ciphertext byte fails verification"
# Without the MAC, CBC lets a corrupted dump decrypt (garbled, not refused) —
# which is why the check exists. Shown, not asserted: openssl's padding check
# may or may not notice, depending on which block was hit.
if decrypt < "$work/tampered.enc" > /dev/null 2>&1; then
  echo "note the tampered file still decrypted without error: only the MAC caught it"
fi

# 3. No .hmac beside the file: refused, never assumed fine.
cp "$work/dump.enc" "$work/orphan.enc"
if verify_hmac "$work/orphan.enc"; then fail "a backup without its .hmac verified"; fi
ok "a missing .hmac fails verification"

# 4. A truncated file.
head -c $((size - 7)) "$work/dump.enc" > "$work/short.enc"
cp "$work/dump.enc.hmac" "$work/short.enc.hmac"
if verify_hmac "$work/short.enc"; then fail "a truncated backup verified"; fi
ok "a truncated backup fails verification"

# 5. Another passphrase derives another MAC key: the .hmac does not verify.
openssl rand -base64 32 > "$work/pass2"
PASSFILE="$work/pass2"
if verify_hmac "$work/dump.enc"; then fail "the MAC verified under another passphrase"; fi
ok "another passphrase does not verify the MAC"
PASSFILE="$work/pass"

# 6. The MAC key is not the passphrase, nor its plain hash.
plain_hash="$(openssl dgst -sha256 -r < "$PASSFILE" | cut -d' ' -f1)"
[ "$(mac_key)" != "$plain_hash" ] || fail "the MAC key is the bare hash of the passphrase"
ok "the MAC key is derived under its own label"

echo "backup-lib: $pass checks passed"
