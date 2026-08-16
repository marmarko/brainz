#!/usr/bin/env bash
# U18 mutation harness.
#
# Applies ONE mutation, runs the named test files, restores the original bytes
# and verifies the restore by digest. Never `git checkout` — twice in this
# repo's history that silently reverted an uncommitted fix and made a surviving
# mutant report as KILLED.
set -uo pipefail

FILE="$1"; shift
OLD="$1"; shift
NEW="$1"; shift
LABEL="$1"; shift

ROOT="/Users/marmarko/code/brainz"
cd "$ROOT" || exit 9

BEFORE=$(shasum -a 256 "$FILE" | cut -d' ' -f1)
BACKUP=$(mktemp)
cp "$FILE" "$BACKUP"

# `$BACKUP` is the restore source; the digest above is the proof of restore.

python3 - "$FILE" "$OLD" "$NEW" <<'PY'
import sys, pathlib
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path); s = p.read_text()
if old not in s:
    print("MUTATION-NOT-APPLIED: pattern absent", file=sys.stderr); sys.exit(9)
if s.count(old) != 1:
    print(f"MUTATION-NOT-APPLIED: pattern appears {s.count(old)} times", file=sys.stderr); sys.exit(9)
p.write_text(s.replace(old, new, 1))
PY
if [ $? -ne 0 ]; then cp "$BACKUP" "$FILE"; rm -f "$BACKUP"; echo "SETUP-FAIL $LABEL"; exit 9; fi

MUTATED=$(shasum -a 256 "$FILE" | cut -d' ' -f1)
if [ "$MUTATED" = "$BEFORE" ]; then
  cp "$BACKUP" "$FILE"; rm -f "$BACKUP"; echo "NO-OP-MUTATION $LABEL"; exit 9
fi

DATABASE_URL=postgres://postgres@localhost:5433/brainz_test bun test "$@" > "/tmp/u18_mut.txt" 2>&1
RESULT=$?

# A run that executed nothing exits non-zero and would report as KILLED. That is
# the same class of lie the whole mutation pass exists to detect, so it is a hard
# error rather than a result.
if ! grep -qE '[0-9]+ pass' /tmp/u18_mut.txt; then
  cp "$BACKUP" "$FILE"; rm -f "$BACKUP"
  echo "NO-TESTS-RAN $LABEL — refusing to report a verdict"; sed 's/\x1b\[[0-9;]*m//g' /tmp/u18_mut.txt | head -6
  exit 9
fi

# Restore the ORIGINAL BYTES and prove it by digest.
cp "$BACKUP" "$FILE"
rm -f "$BACKUP"
AFTER=$(shasum -a 256 "$FILE" | cut -d' ' -f1)
if [ "$AFTER" != "$BEFORE" ]; then
  echo "RESTORE-FAILED $LABEL — $FILE differs from its pre-mutation bytes"; exit 9
fi

if [ $RESULT -eq 0 ]; then
  echo "SURVIVED  $LABEL"
else
  echo "KILLED    $LABEL"
  sed 's/\x1b\[[0-9;]*m//g' /tmp/u18_mut.txt | grep -E "✗" | sed 's/^/          /'
  sed 's/\x1b\[[0-9;]*m//g' /tmp/u18_mut.txt | grep -E "^ *[0-9]+ (pass|fail)" | sed 's/^/          /' 
fi
exit 0
