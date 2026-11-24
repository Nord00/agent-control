# agent-control

## Verify before done

- `scripts/verify.sh` is the project's check (build, syntax, server smoke test). Run it after every
  code change and fix what it reports until it prints `VERIFY: PASS`. Don't call work done before that.
- When you add or change behavior that verify.sh can test (an endpoint, a status, a calculation),
  add a check for it in verify.sh in the same change.
- Never weaken, skip or delete an existing check to make verify.sh pass. If a check is wrong
  because the behavior was meant to change, say so to the user and change it openly.
- When you add or change a check, mention it in your summary so the user can review it.

## Long unattended tasks

`loop/run.sh "<task>"` runs Claude in repeated fresh sessions until the task is done
(see loop/PROMPT.md). Only for large tasks; normal work happens directly in the session.
