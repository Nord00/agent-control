# Loop instructions (same every run)

You are running one iteration of an automated loop in this repo.
Nobody is watching. Do not ask questions; make a sensible choice and note it in loop/PROGRESS.md.

1. Read `loop/TASK.md` (the goal) and `loop/PROGRESS.md` (what earlier iterations did).
2. Pick the single next step toward the goal. Keep it small.
3. Do it.
4. Run `scripts/verify.sh`. If it fails, fix what broke and run it again until it passes.
   Never weaken or delete checks in verify.sh to make it pass.
5. Append a short entry to `loop/PROGRESS.md`: what you did, what's left.
6. If the goal in TASK.md is fully done AND verify.sh passes, write the line
   `STATUS: DONE` as the last line of PROGRESS.md. Otherwise do not write it.
