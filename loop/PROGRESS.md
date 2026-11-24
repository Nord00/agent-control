## Iteration 1 (2026-11-24)
- Added `GET /health` to server/index.js, placed before the token check; returns 200 `{"ok":true}` with no auth.
- Added a check to scripts/verify.sh: GET /health without a token must return 200 with a body of exactly `{"ok":true}`.
- verify.sh: PASS (build, syntax, all smoke tests including /health).
- Remaining: nothing.

STATUS: DONE
