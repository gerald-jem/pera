#!/usr/bin/env bash
# Run every Pera test against the app in this folder's parent, with invented sample data.
#   one-time setup:  pip install playwright && python3 -m playwright install chromium && (cd tests && npm i axe-core@4)
#   run:             bash tests/run_all.sh          (CHROME=/path/to/chrome to use your own browser)
# Screenshots land in tests/out/. A test fails if it crashes or the page logs an error.
cd "$(dirname "$0")"
[ -f fixtures/sample-backup.json ] || python3 make_fixtures.py
fail=0
for t in test_*.py; do
  printf '%-45s' "$t"
  out=$(timeout 300 python3 "$t" 2>&1)
  if echo "$out" | grep -q 'Traceback' || echo "$out" | grep -iE 'errors' | grep -q "\['"; then
    echo "FAIL"; echo "$out" | grep -E 'Error|errors|Traceback' | head -5 | sed 's/^/    /'; fail=1
  else echo "ok"; fi
done
exit $fail
