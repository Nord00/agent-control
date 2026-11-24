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
PORT=$PORT AGENT_CONTROL_TOKEN=$TOKEN AGENT_CONTROL_DATA=$DATA node server/index.js >/tmp/verify-server.log 2>&1 &
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

if [ $fail -ne 0 ]; then echo; echo "Server log:"; tail -20 /tmp/verify-server.log; fi

echo
[ $fail -eq 0 ] && echo "VERIFY: PASS" || echo "VERIFY: FAIL"
exit $fail
