---
name: task-loop
description: Run the project's autonomous loop (loop/run.sh) on a task the user writes in chat. Use when the user types /task-loop <task> or asks to "run the loop on" / "loopa" something.
argument-hint: "<what should be done>"
---

The user wants the loop to do this task: $ARGUMENTS

1. Turn it into a short goal (2–4 sentences) that ends with a line starting `Done when:`
   that names something `scripts/verify.sh` can check. If the task adds behavior that
   verify.sh doesn't test yet, the goal says to add a check for it.
   If the task is too vague to state when it's done, ask the user one question instead of starting.
2. Run `loop/run.sh -n 5 "<goal>"` with Bash in the background (run_in_background).
   Do not edit loop/TASK.md or loop/PROGRESS.md yourself; run.sh does that.
3. Tell the user in one or two lines that it's running and what goal you gave it.
4. When the run finishes, read its output and loop/PROGRESS.md, show what changed
   (`git diff` for the touched files), run `scripts/verify.sh` yourself, and report.
   If it stopped without `STATUS: DONE`, say so and what's left. Commit nothing.
