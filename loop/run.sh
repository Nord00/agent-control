#!/usr/bin/env bash
# Runs Claude repeatedly with the same instructions until the task is done.
#
# Usage:
#   loop/run.sh "Add a GET /health endpoint ..."     new task (default 10 iterations)
#   loop/run.sh -n 5 "Add a GET /health endpoint ..." new task, at most 5 iterations
#   loop/run.sh                                       continue the task already in TASK.md
#
# A new task replaces loop/TASK.md and starts a fresh loop/PROGRESS.md;
# the old log is kept in loop/history/.
set -euo pipefail
cd "$(dirname "$0")/.."

MAX=10
if [ "${1:-}" = "-n" ]; then MAX=$2; shift 2; fi
TASK="${*:-}"

if [ -n "$TASK" ]; then
  if [ -s loop/PROGRESS.md ]; then
    mkdir -p loop/history
    mv loop/PROGRESS.md "loop/history/$(date +%Y%m%d-%H%M%S).md"
  fi
  printf '# Goal\n\n%s\n' "$TASK" > loop/TASK.md
  : > loop/PROGRESS.md
elif tail -n 1 loop/PROGRESS.md 2>/dev/null | grep -q '^STATUS: DONE'; then
  echo "The task in loop/TASK.md is already done. Give a new task: loop/run.sh \"...\""
  exit 0
fi
touch loop/PROGRESS.md

echo "Task: $(sed -n '3,$p' loop/TASK.md | head -3)"
for i in $(seq 1 "$MAX"); do
  echo "=== Iteration $i/$MAX ==="
  claude -p "$(cat loop/PROMPT.md)" \
    --permission-mode acceptEdits \
    --allowedTools "Bash(scripts/verify.sh)" "Bash(npm run build*)" "Bash(node *)" "Bash(git diff*)" "Bash(git status*)"

  if tail -n 1 loop/PROGRESS.md | grep -q '^STATUS: DONE'; then
    echo "Done after $i iteration(s)."
    exit 0
  fi
done

echo "Stopped after $MAX iterations without STATUS: DONE. See loop/PROGRESS.md."
exit 1
