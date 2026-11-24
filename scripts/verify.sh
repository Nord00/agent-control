#!/usr/bin/env bash
# The loop's feedback signal: one command that says whether the project works.
# Exit 0 = everything passed. Anything else = the output says what broke.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
step() { printf '\n== %s\n' "$1"; }
ok() { printf 'OK  %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=1; }

step "TypeScript + Vite build"
if npm run build --silent >/tmp/verify-build.log 2>&1; then ok build; else bad build; tail -40 /tmp/verify-build.log; fi

step "Syntax check of server and hook files"
for f in server/*.js hooks/*.mjs scripts/*.mjs; do
  node --check "$f" 2>&1 && ok "$f" || bad "$f"
done

step "Server smoke test"
PORT=$((40000 + RANDOM % 10000))
TOKEN=verify-test-token
DATA=$(mktemp -d)/agents.json
# Review mode runs this stand-in for claude: it reports what it was given and returns fixed findings.
REVIEW_TMP=$(mktemp -d)
WORKTREES=$REVIEW_TMP/worktrees
STUB=$REVIEW_TMP/claude-stub.mjs
cat >"$STUB" <<'JS'
#!/usr/bin/env node
import fs from 'node:fs'
let prompt = ''
process.stdin.on('data', (c) => (prompt += c)).on('end', () => {
  const args = process.argv.slice(2)
  if (prompt.includes('PLEASE-FAIL')) {
    process.stderr.write('stub: asked to fail\n')
    process.exit(3)
  }
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'))
  const info = [
    `worktree=${fs.existsSync('app.js')}`,
    `mode=${args[args.indexOf('--permission-mode') + 1]}`,
    `writes=${allowed.some((t) => /^(Write|Edit)$/.test(t))}`,
    `ticket=${prompt.includes('TICKET-TEXT')}`,
    `schema=${args.includes('--json-schema')}`,
  ].join(' ')
  const findings = [
    { severity: 'low', category: 'maintainability', file: 'app.js', line: 1, title: 'Low one', detail: 'd' },
    { severity: 'high', category: 'bug', file: `${process.cwd()}/app.js`, line: 3, title: 'Divides by zero', detail: 'd', scenario: 'b = 0' },
  ]
  console.log(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.01, num_turns: 2, structured_output: { summary: info, verdict: 'request_changes', ticket: { addressed: 'partly', notes: 'n' }, findings } }))
})
JS
chmod +x "$STUB"
PORT=$PORT AGENT_CONTROL_TOKEN=$TOKEN AGENT_CONTROL_DATA=$DATA AGENT_CONTROL_CLAUDE=$STUB AGENT_CONTROL_WORKTREES=$WORKTREES \
  node server/index.js >/tmp/verify-server.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for _ in $(seq 1 30); do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 0.2; done

base="http://localhost:$PORT"
code=$(curl -s -o /dev/null -w '%{http_code}' "$base/")
[ "$code" = 200 ] && ok "GET / -> 200" || bad "GET / -> $code"

code=$(curl -s -o /tmp/verify-health.json -w '%{http_code}' "$base/health")
hbody=$(cat /tmp/verify-health.json 2>/dev/null)
[ "$code" = 200 ] && [ "$hbody" = '{"ok":true}' ] && ok "GET /health without token -> 200 {\"ok\":true}" || bad "GET /health -> $code $hbody (want 200 {\"ok\":true})"

code=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/agents")
[ "$code" = 401 ] && ok "GET /api/agents without token -> 401" || bad "GET /api/agents without token -> $code (want 401)"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/events" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"verify-1","name":"verify","status":"working"}')
[ "$code" = 200 ] && ok "POST /events -> 200" || bad "POST /events -> $code"

body=$(curl -s "$base/api/agents" -H "Authorization: Bearer $TOKEN")
echo "$body" | grep -q '"verify-1"' && ok "agent shows up in /api/agents" || bad "agent missing from /api/agents: $body"

step "Approvals from the dashboard"
auth="Authorization: Bearer $TOKEN"
jget() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const v=JSON.parse(s);const r=('"$1"');console.log(r===undefined?"":typeof r==="string"?r:JSON.stringify(r))}catch{console.log("")}})'; }
ask() { # $1 session, $2 wait ms -> approval id
  curl -s -X POST "$base/events" -H "$auth" -H 'Content-Type: application/json' \
    -d "{\"app\":\"claude\",\"session_id\":\"$1\",\"hook_event_name\":\"PermissionRequest\",\"tool_name\":\"Bash\",\"approval\":{\"tool\":\"Bash\",\"summary\":\"echo hi\",\"details\":\"echo hi\",\"waitMs\":$2}}" | jget v.approval
}
set=$(curl -s "$base/api/settings" | jget '[v.approvals.claude,v.approvals.codex].join()')
[ "$set" = "true,false" ] && ok "Default settings: dashboard approvals on for Claude Code, off for Codex" || bad "default settings: $set (want true,false)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/settings" -d '{"approvals":{"codex":true}}')
[ "$code" = 401 ] && ok "POST /api/settings without token -> 401" || bad "settings without token -> $code (want 401)"
cid=$(curl -s -X POST "$base/events" -H "$auth" -H 'Content-Type: application/json' \
  -d '{"app":"codex","session_id":"verify-codex-off","hook_event_name":"PermissionRequest","tool_name":"Bash","approval":{"tool":"Bash","waitMs":20000}}' | jget v.approval)
[ -z "$cid" ] && ok "Codex off: no approval id, so Codex asks right away" || bad "Codex off still created approval $cid"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/settings" -H "$auth" -d '{"approvals":{"codex":"yes"}}')
[ "$code" = 400 ] && ok "Invalid setting -> 400" || bad "invalid setting -> $code (want 400)"
set=$(curl -s -X POST "$base/api/settings" -H "$auth" -d '{"approvals":{"codex":true}}' | jget '[v.approvals.claude,v.approvals.codex].join()')
[ "$set" = "true,true" ] && ok "Turning Codex on keeps Claude Code's setting" || bad "after enabling codex: $set (want true,true)"
cid=$(curl -s -X POST "$base/events" -H "$auth" -H 'Content-Type: application/json' \
  -d '{"app":"codex","session_id":"verify-codex-on","hook_event_name":"PermissionRequest","tool_name":"Bash","approval":{"tool":"Bash","waitMs":20000}}' | jget v.approval)
curl -s "$base/api/approvals/$cid/wait" -H "$auth" >/tmp/verify-wait.json &
WPID=$!
sleep 0.3
curl -s -o /dev/null -X POST "$base/api/settings" -H "$auth" -d '{"approvals":{"codex":false}}'
wait $WPID
got=$(jget v.decision </tmp/verify-wait.json)
[ -n "$cid" ] && [ "$got" = null ] && ok "Turning Codex off hands its waiting request back" || bad "turn off: id '$cid', hook got '$got'"
curl -s -o /dev/null -X POST "$base/api/settings" -H "$auth" -d '{"approvals":{"codex":true}}' # the checks below use Codex

aid=$(ask verify-ap 20000)
[ -n "$aid" ] && ok "PermissionRequest with approval -> approval id" || bad "PermissionRequest returned no approval id"

code=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/approvals")
[ "$code" = 401 ] && ok "GET /api/approvals without token -> 401" || bad "GET /api/approvals without token -> $code (want 401)"
summary=$(curl -s "$base/api/approvals" -H "$auth" | jget 'v.find(a=>a.id==="'"$aid"'")?.summary')
[ "$summary" = "echo hi" ] && ok "GET /api/approvals lists the request with its command" || bad "approval missing from /api/approvals: $summary"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/approvals/$aid" -d '{"decision":"allow"}')
[ "$code" = 401 ] && ok "POST /api/approvals/:id without token -> 401" || bad "deciding without token -> $code (want 401)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/approvals/$aid" -H "$auth" -H 'Origin: http://evil.example' -d '{"decision":"allow"}')
[ "$code" = 403 ] && ok "POST /api/approvals/:id from another origin -> 403" || bad "cross-origin decide -> $code (want 403)"

curl -s "$base/api/approvals/$aid/wait" -H "$auth" >/tmp/verify-wait.json &
WPID=$!
sleep 0.3
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/approvals/$aid" -H "$auth" -d '{"decision":"allow"}')
wait $WPID
got=$(jget v.decision </tmp/verify-wait.json)
[ "$code" = 200 ] && [ "$got" = allow ] && ok "Allow reaches the waiting hook" || bad "allow: POST $code, hook got '$got' (want 200, allow)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/approvals/$aid" -H "$auth" -d '{"decision":"deny"}')
[ "$code" = 404 ] && ok "Answering twice -> 404" || bad "second answer -> $code (want 404)"
att=$(curl -s "$base/api/agents" -H "$auth" | jget 'v.find(a=>a.id==="verify-ap")?.attention')
[ "$att" = false ] && ok "Answered agent no longer needs approval" || bad "agent attention after answer: $att (want false)"

aid=$(ask verify-ap2 20000)
curl -s "$base/api/approvals/$aid/wait" -H "$auth" >/tmp/verify-wait.json &
WPID=$!
sleep 0.3
curl -s -o /dev/null -X POST "$base/api/approvals/$aid" -H "$auth" -d '{"decision":"deny"}'
wait $WPID
got=$(jget v.decision </tmp/verify-wait.json)
[ "$got" = deny ] && ok "Deny reaches the waiting hook" || bad "deny: hook got '$got'"

aid=$(ask verify-ap3 800)
got=$(curl -s --max-time 5 "$base/api/approvals/$aid/wait" -H "$auth" | jget v.decision)
left=$(curl -s "$base/api/approvals" -H "$auth" | jget 'v.length')
[ "$got" = null ] && [ "$left" = 0 ] && ok "Unanswered approval times out with no decision" || bad "timeout: hook got '$got', $left still pending"

aid=$(ask verify-ap4 20000)
curl -s -o /dev/null -X POST "$base/events" -H "$auth" -d '{"app":"claude","session_id":"verify-ap4","hook_event_name":"Stop"}'
left=$(curl -s "$base/api/approvals" -H "$auth" | jget 'v.length')
[ "$left" = 0 ] && ok "Turn ending drops its pending approvals" || bad "after Stop, $left approvals still pending"

qid=$(curl -s -X POST "$base/events" -H "$auth" -H 'Content-Type: application/json' \
  -d '{"app":"claude","session_id":"verify-q","hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","approval":{"tool":"AskUserQuestion","waitMs":20000,"questions":[{"question":"Which DB?","header":"DB","options":[{"label":"Postgres"},{"label":"SQLite"}]}]}}' | jget v.approval)
kind=$(curl -s "$base/api/approvals" -H "$auth" | jget 'v.find(a=>a.id==="'"$qid"'")?.kind')
[ "$kind" = question ] && ok "AskUserQuestion becomes a question" || bad "question kind: '$kind'"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/approvals/$qid" -H "$auth" -d '{"decision":"allow","answers":{"Other question?":"x"}}')
[ "$code" = 400 ] && ok "Answer to an unknown question -> 400" || bad "unknown-question answer -> $code (want 400)"
curl -s "$base/api/approvals/$qid/wait" -H "$auth" >/tmp/verify-wait.json &
WPID=$!
sleep 0.3
curl -s -o /dev/null -X POST "$base/api/approvals/$qid" -H "$auth" -d '{"decision":"allow","answers":{"Which DB?":"SQLite"}}'
wait $WPID
got=$(jget 'v.decision+" "+v.answers["Which DB?"]' </tmp/verify-wait.json)
[ "$got" = "allow SQLite" ] && ok "Answers reach the waiting hook" || bad "answers: hook got '$got'"

pid=$(ask verify-pass 20000)
curl -s "$base/api/approvals/$pid/wait" -H "$auth" >/tmp/verify-wait.json &
WPID=$!
sleep 0.3
curl -s -o /dev/null -X POST "$base/api/approvals/$pid" -H "$auth" -d '{"decision":"pass"}'
wait $WPID
got=$(jget v.decision </tmp/verify-wait.json)
[ "$got" = null ] && ok "\"Answer in the app instead\" hands back with no decision" || bad "pass: hook got '$got'"

step "Hook script"
HOOK_HOME=$(mktemp -d) # no real config.json
hook() { printf '%s' "$2" | HOME=$HOOK_HOME AGENT_CONTROL_URL=$base AGENT_CONTROL_TOKEN=$TOKEN node hooks/claude-hook.mjs $1 >/dev/null; }
hook codex '{"session_id":"verify-codex-real","hook_event_name":"SessionStart","cwd":"/tmp/x","transcript_path":"/tmp/x.jsonl","source":"startup"}'
hook codex '{"session_id":"verify-codex-fork","hook_event_name":"SessionStart","cwd":"/tmp/x","transcript_path":null,"source":"fork"}'
ids=$(curl -s "$base/api/agents" -H "$auth" | jget 'v.map(a=>a.id).join(" ")')
case " $ids " in *" verify-codex-real "*) ok "Codex session shows up" ;; *) bad "Codex session missing: $ids" ;; esac
case " $ids " in *" verify-codex-fork "*) bad "Codex helper session (no transcript) was shown" ;; *) ok "Codex helper session without transcript is ignored" ;; esac

curl -s -o /dev/null -X POST "$base/events" -H "$auth" -d '{"app":"claude","session_id":"verify-sub","hook_event_name":"SessionStart","cwd":"/tmp/x"}'
curl -s -o /dev/null -X POST "$base/events" -H "$auth" -d '{"app":"claude","session_id":"verify-sub","hook_event_name":"SubagentStart","agent_id":"verify-sub-real","agent_type":"Explore"}'
curl -s -o /dev/null -X POST "$base/events" -H "$auth" -d '{"app":"claude","session_id":"verify-sub","hook_event_name":"SubagentStop","agent_id":"verify-sub-real","agent_type":"Explore"}'
curl -s -o /dev/null -X POST "$base/events" -H "$auth" -d '{"app":"claude","session_id":"verify-sub","hook_event_name":"SubagentStop","agent_id":"verify-sub-ghost"}'
subs=$(curl -s "$base/api/agents" -H "$auth" | jget 'v.filter(a=>a.parentId==="verify-sub").map(a=>a.id+":"+a.status).join()')
[ "$subs" = "verify-sub-real:completed" ] && ok "SubagentStop without a start (internal helper) is ignored" || bad "subagents of verify-sub: '$subs' (want verify-sub-real:completed)"

# A question answered from the dashboard comes back as allow + the input with answers.
OUT=$(mktemp)
printf '%s' '{"session_id":"verify-hq","hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Pick one?","header":"Pick","options":[{"label":"A"},{"label":"B"}],"multiSelect":false}]}}' \
  | HOME=$HOOK_HOME AGENT_CONTROL_URL=$base AGENT_CONTROL_TOKEN=$TOKEN node hooks/claude-hook.mjs >"$OUT" &
HPID=$!
hq=""
for _ in $(seq 1 20); do
  hq=$(curl -s "$base/api/approvals" -H "$auth" | jget 'v.find(a=>a.sessionId==="verify-hq")?.id')
  [ -n "$hq" ] && break
  sleep 0.1
done
curl -s -o /dev/null -X POST "$base/api/approvals/$hq" -H "$auth" -d '{"decision":"allow","answers":{"Pick one?":"B"}}'
wait $HPID
got=$(jget 'v.hookSpecificOutput.decision.behavior+" "+v.hookSpecificOutput.decision.updatedInput.answers["Pick one?"]+" "+v.hookSpecificOutput.decision.updatedInput.questions.length' <"$OUT")
[ "$got" = "allow B 1" ] && ok "Hook answers AskUserQuestion with updatedInput.answers" || bad "hook question output: '$got' ($(cat "$OUT"))"

# Codex rejects updatedInput: its allow must be the bare decision.
printf '%s' '{"session_id":"verify-hc","hook_event_name":"PermissionRequest","transcript_path":"/tmp/x.jsonl","tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | HOME=$HOOK_HOME AGENT_CONTROL_URL=$base AGENT_CONTROL_TOKEN=$TOKEN node hooks/claude-hook.mjs codex >"$OUT" &
HPID=$!
hc=""
for _ in $(seq 1 20); do
  hc=$(curl -s "$base/api/approvals" -H "$auth" | jget 'v.find(a=>a.sessionId==="verify-hc")?.id')
  [ -n "$hc" ] && break
  sleep 0.1
done
curl -s -o /dev/null -X POST "$base/api/approvals/$hc" -H "$auth" -d '{"decision":"allow"}'
wait $HPID
got=$(jget 'JSON.stringify(v.hookSpecificOutput.decision)' <"$OUT")
[ "$got" = '{"behavior":"allow"}' ] && ok "Codex gets a bare allow (no updatedInput)" || bad "codex allow output: '$got'"

step "Review mode"
REPO=$REVIEW_TMP/demo-repo
g() { git -C "$REPO" -c user.name=verify -c user.email=verify@example.invalid "$@"; }
git init -q -b main "$REPO"
printf 'export function ratio(a, b) {\n  if (b === 0) return 0\n  return a / b\n}\n' >"$REPO/app.js"
g add app.js && g commit -qm base
g checkout -qb feature
printf 'export function ratio(a, b) {\n  // no guard any more\n  return a / b\n}\n' >"$REPO/app.js"
g commit -qam change
g checkout -q main
rpost() { curl -s -X POST "$base$1" -H "$auth" -H 'Content-Type: application/json' -d "$2"; }
rwait() { # $1 review id -> final status
  for _ in $(seq 1 50); do
    st=$(curl -s "$base/api/reviews/$1" -H "$auth" | jget v.status)
    [ "$st" != running ] && break
    sleep 0.2
  done
  echo "$st"
}

code=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/reviews")
[ "$code" = 401 ] && ok "GET /api/reviews without token -> 401" || bad "GET /api/reviews without token -> $code (want 401)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/review/repos" -H "$auth" -d '{"path":"/no/such/repo"}')
[ "$code" = 400 ] && ok "Adding a path that isn't a git repo -> 400" || bad "add non-repo -> $code (want 400)"
added=$(rpost /api/review/repos "{\"path\":\"$REPO\"}" | jget v.added)
REPO_TOP=$(git -C "$REPO" rev-parse --show-toplevel)
[ "$added" = "$REPO_TOP" ] && ok "Adding a git repo -> listed by its top folder" || bad "add repo: '$added' (want $REPO_TOP)"
br=$(curl -s -G "$base/api/review/branches" --data-urlencode "repo=$REPO_TOP" -H "$auth" | jget 'v.base+" "+v.branches.map(b=>b.name).sort().join()')
[ "$br" = "main feature,main" ] && ok "Branches listed with main as the default base" || bad "branches: '$br' (want 'main feature,main')"
REPO2=$REVIEW_TMP/session-repo
git init -q -b main "$REPO2" && mkdir -p "$REPO2/sub"
git -C "$REPO2" -c user.name=verify -c user.email=verify@example.invalid commit -q --allow-empty -m init
REPO2_TOP=$(git -C "$REPO2" rev-parse --show-toplevel)
curl -s -o /dev/null -X POST "$base/events" -H "$auth" -d "{\"app\":\"claude\",\"session_id\":\"verify-repo-session\",\"hook_event_name\":\"SessionStart\",\"cwd\":\"$REPO2/sub\"}"
src=""
for _ in $(seq 1 20); do
  src=$(curl -s "$base/api/review/repos" -H "$auth" | jget 'v.find(r=>r.path==="'"$REPO2_TOP"'")?.source')
  [ -n "$src" ] && break
  sleep 0.1
done
br=$(curl -s -G "$base/api/review/branches" --data-urlencode "repo=$REPO2_TOP" -H "$auth" | jget 'v.base')
[ "$src" = session ] && [ "$br" = main ] && ok "A session's repo is offered for review without adding it" || bad "session repo: source '$src', branches base '$br'"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/reviews" -H "$auth" -d "{\"repo\":\"$REPO_TOP\",\"branch\":\"main\",\"base\":\"main\"}")
[ "$code" = 400 ] && ok "Reviewing a branch against itself -> 400" || bad "same branch review -> $code (want 400)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/reviews" -H "$auth" -d "{\"repo\":\"$REPO_TOP\",\"branch\":\"--output=x\",\"base\":\"main\"}")
[ "$code" = 400 ] && ok "A branch name that looks like an option -> 400" || bad "option-like branch -> $code (want 400)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/reviews" -H "$auth" -H 'Origin: http://evil.example' -d "{\"repo\":\"$REPO_TOP\",\"branch\":\"feature\",\"base\":\"main\"}")
[ "$code" = 403 ] && ok "Starting a review from another origin -> 403" || bad "cross-origin review -> $code (want 403)"

rid=$(rpost /api/reviews "{\"repo\":\"$REPO_TOP\",\"branch\":\"feature\",\"base\":\"main\",\"ticket\":\"TICKET-TEXT: keep the guard\"}" | jget v.id)
st=$(rwait "$rid")
rv=$(curl -s "$base/api/reviews/$rid" -H "$auth")
[ "$st" = done ] && ok "Review runs and finishes" || bad "review status: '$st' ($(echo "$rv" | jget v.error))"
got=$(echo "$rv" | jget v.summary)
[ "$got" = "worktree=true mode=dontAsk writes=false ticket=true schema=true" ] \
  && ok "Review agent runs read-only in a checkout of the branch, with the ticket and the schema" || bad "what the agent got: '$got'"
got=$(echo "$rv" | jget 'v.findings.map(f=>f.severity+":"+f.file+":"+f.line).join()')
[ "$got" = "high:app.js:3,low:app.js:1" ] && ok "Findings sorted by severity, paths relative to the repo" || bad "findings: '$got'"
got=$(echo "$rv" | jget 'v.findings[0].hunk.lines.includes("-  if (b === 0) return 0")')
[ "$got" = true ] && ok "Each finding carries the diff hunk around its line" || bad "hunk: $(echo "$rv" | jget 'v.findings[0].hunk')"
got=$(echo "$rv" | jget '[v.verdict,v.ticketCoverage.addressed,/^[0-9a-f-]{36}$/.test(v.agentId)].join()')
[ "$got" = "request_changes,partly,true" ] && ok "Verdict, ticket coverage and the agent's session id are kept" || bad "review fields: '$got'"
left=$(ls -A "$WORKTREES" 2>/dev/null | wc -l | tr -d ' ')
wtl=$(git -C "$REPO_TOP" worktree list | wc -l | tr -d ' ')
[ "$left" = 0 ] && [ "$wtl" = 1 ] && ok "The review's worktree is removed afterwards" || bad "worktrees left: $left on disk, $wtl in git"

got=$(rpost "/api/reviews/$rid/findings/f1" '{"status":"dismissed"}' | jget '[v.findings[0].status,v.counts.high,v.counts.low].join()')
[ "$got" = "dismissed,0,1" ] && ok "Dismissing a finding takes it out of the open counts" || bad "dismiss: '$got' (want dismissed,0,1)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/reviews/$rid/findings/f1" -H "$auth" -d '{"status":"maybe"}')
[ "$code" = 400 ] && ok "Unknown finding status -> 400" || bad "bad finding status -> $code (want 400)"
got=$(curl -s "$base/api/reviews" -H "$auth" | jget 'v[0].id+" "+(v[0].findings===undefined)')
[ "$got" = "$rid true" ] && ok "Review list has summaries without the findings" || bad "review list: '$got'"

fid=$(rpost /api/reviews "{\"repo\":\"$REPO_TOP\",\"branch\":\"feature\",\"base\":\"main\",\"ticket\":\"PLEASE-FAIL\"}" | jget v.id)
st=$(rwait "$fid")
err=$(curl -s "$base/api/reviews/$fid" -H "$auth" | jget v.error)
[ "$st" = failed ] && [ "$err" = "stub: asked to fail" ] && ok "A failing review agent ends as failed with its error" || bad "failing review: '$st' '$err'"
code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$base/api/reviews/$fid" -H "$auth")
gone=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/reviews/$fid" -H "$auth")
[ "$code" = 200 ] && [ "$gone" = 404 ] && ok "Deleting a review removes it" || bad "delete review: $code, then $gone"

# A clone whose remote has moved on: its local main and feature are behind origin.
CLONE=$REVIEW_TMP/clone
git clone -q "$REPO" "$CLONE"
git -C "$CLONE" checkout -q -b feature origin/feature
git -C "$CLONE" checkout -q main
g commit -q --allow-empty -m "main moves on"
g checkout -q feature && g commit -q --allow-empty -m "feature moves on" && g checkout -q main
g checkout -qb pushed-later && g commit -q --allow-empty -m "new branch" && g checkout -q main
CLONE_TOP=$(rpost /api/review/repos "{\"path\":\"$CLONE\"}" | jget v.added)
bl() { curl -s -G "$base/api/review/branches" --data-urlencode "repo=$CLONE_TOP" ${1:+--data-urlencode "fetch=$1"} -H "$auth"; }
got=$(bl | jget '[v.base, v.branches.some(b=>b.name==="origin/pushed-later")].join()')
[ "$got" = "main,false" ] && ok "Without a fetch, branches are what was fetched last" || bad "before fetch: '$got' (want main,false)"
bj=$(bl 1)
got=$(echo "$bj" | jget '[!v.fetchError, v.branches.some(b=>b.name==="origin/pushed-later"&&b.remote===true)].join()')
[ "$got" = "true,true" ] && ok "Choosing a repo fetches its remote: new remote branches show up" || bad "after fetch: '$got' ($(echo "$bj" | jget v.fetchError))"
got=$(echo "$bj" | jget 'JSON.stringify(v.branches.filter(b=>b.name==="feature"||b.name==="origin/feature").map(b=>[b.name,b.remote,b.behind]).sort())')
[ "$got" = '[["feature","origin/feature",1],["origin/feature",true,null]]' ] \
  && ok "A local branch behind its remote shows how far, next to the remote one" || bad "feature vs origin/feature: $got"
got=$(echo "$bj" | jget 'v.base')
[ "$got" = origin/main ] && ok "Base is origin/main when the local main is behind it" || bad "base with stale main: '$got' (want origin/main)"
rid=$(rpost /api/reviews "{\"repo\":\"$CLONE_TOP\",\"branch\":\"origin/feature\",\"base\":\"origin/main\"}" | jget v.id)
st=$(rwait "$rid")
[ "$st" = done ] && ok "A remote branch can be reviewed without checking it out" || bad "remote branch review: '$st'"
git -C "$CLONE" remote set-url origin "$REVIEW_TMP/no-such-remote"
got=$(bl force | jget '[!!v.fetchError, v.branches.some(b=>b.name==="origin/pushed-later")].join()')
[ "$got" = "true,true" ] && ok "A failed fetch is reported and the last fetched branches stay" || bad "failed fetch: '$got' (want true,true)"

step "Startup cleanup of saved helper subagents"
GDIR=$(mktemp -d)
NOW=$(node -e 'console.log(Date.now())')
cat >"$GDIR/agents.json" <<JSON
[
 {"id":"g-root","parentId":null,"name":"root","task":"","status":"working","startedAt":$NOW,"lastEventAt":$NOW},
 {"id":"g-ghost","parentId":"g-root","name":"subagent","task":"Subagent finished","status":"completed","startedAt":$NOW,"endedAt":$((NOW+40)),"lastEventAt":$((NOW+40))},
 {"id":"g-typed","parentId":"g-root","name":"Explore","task":"Subagent finished","status":"completed","startedAt":$NOW,"endedAt":$((NOW+40)),"lastEventAt":$((NOW+40))},
 {"id":"g-worked","parentId":"g-root","name":"subagent","task":"Subagent finished","status":"completed","requests":3,"startedAt":$NOW,"endedAt":$((NOW+40)),"lastEventAt":$((NOW+40))},
 {"id":"g-long","parentId":"g-root","name":"subagent","task":"Subagent finished","status":"completed","startedAt":$NOW,"endedAt":$((NOW+60000)),"lastEventAt":$((NOW+60000))}
]
JSON
GPORT=$((PORT + 1))
PORT=$GPORT AGENT_CONTROL_TOKEN=$TOKEN AGENT_CONTROL_DATA=$GDIR/agents.json node server/index.js >/tmp/verify-server2.log 2>&1 &
GPID=$!
for _ in $(seq 1 30); do curl -s -o /dev/null "http://localhost:$GPORT/health" && break; sleep 0.2; done
kept=$(curl -s "http://localhost:$GPORT/api/agents" -H "$auth" | jget 'v.map(a=>a.id).sort().join()')
kill $GPID 2>/dev/null
[ "$kept" = "g-long,g-root,g-typed,g-worked" ] && ok "Saved helper subagents are removed at startup, real ones kept" || bad "after startup cleanup: '$kept' (want g-long,g-root,g-typed,g-worked)"

if [ $fail -ne 0 ]; then echo; echo "Server log:"; tail -20 /tmp/verify-server.log; fi

echo
[ $fail -eq 0 ] && echo "VERIFY: PASS" || echo "VERIFY: FAIL"
exit $fail
