// Review mode: pick a repo and a branch, optionally paste the ticket, and a read-only Claude Code
// agent reviews the branch's changes in a throwaway git worktree. Findings come back as
// structured JSON (claude -p --json-schema) and are kept in data/reviews.json.
//
// The review agent is an ordinary `claude` process, so the user's hooks show it on the dashboard
// like any other session; the review records that session's id to link the two.
import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CLAUDE = process.env.AGENT_CONTROL_CLAUDE || 'claude'
const WORKTREES = process.env.AGENT_CONTROL_WORKTREES || path.join(os.tmpdir(), 'agent-control-reviews')
const TIMEOUT_MS = Number(process.env.AGENT_CONTROL_REVIEW_TIMEOUT_MS) || 30 * 60 * 1000
const MAX_REVIEWS = 100
const MAX_RUNNING = 3
const SEVERITIES = ['high', 'medium', 'low']
const CATEGORIES = ['bug', 'security', 'ticket', 'performance', 'maintainability', 'tests']
const VERDICTS = ['approve', 'comment', 'request_changes']
const COVERAGE = ['yes', 'partly', 'no', 'unclear']
const FINDING_STATUSES = new Set(['open', 'accepted', 'dismissed'])

// Read-only: it can look at files and git history, and nothing else. dontAsk refuses the rest
// instead of waiting for a prompt nobody would see.
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)']
const DISALLOWED_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch']

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two to four sentences: what the change does and your overall assessment.' },
    verdict: { type: 'string', enum: VERDICTS },
    ticket: {
      type: 'object',
      description: 'Only when a ticket description was given.',
      properties: {
        addressed: { type: 'string', enum: COVERAGE },
        notes: { type: 'string', description: 'What is done, what is missing or different from the ticket.' },
      },
      required: ['addressed', 'notes'],
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          category: { type: 'string', enum: CATEGORIES },
          file: { type: 'string', description: 'Path relative to the repository root.' },
          line: { type: 'integer', description: 'Line in the new version of the file.' },
          title: { type: 'string', description: 'The problem in one short sentence.' },
          detail: { type: 'string', description: 'Why it is a problem, pointing at the code.' },
          scenario: { type: 'string', description: 'Concrete input or state, and the wrong result it leads to.' },
          suggestion: { type: 'string', description: 'How to fix it, briefly.' },
        },
        required: ['severity', 'category', 'file', 'title', 'detail'],
      },
    },
  },
  required: ['summary', 'verdict', 'findings'],
}

const text = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined)

// Never wait for a password or a host-key prompt: nobody would see it. No optional locks either:
// `git status` would otherwise take index.lock in your repo while you or an agent work in it.
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
}
const FETCH_TIMEOUT_MS = 20_000
const FETCH_EVERY_MS = 30_000 // picking the same repo again within this reuses the last fetch

function git(cwd, args, maxBuffer = 20 * 1024 * 1024, timeout = 0, env = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer, encoding: 'utf8', env: { ...GIT_ENV, ...env }, timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.killed ? 'timed out' : (stderr || err.message).trim().split('\n')[0].slice(0, 300)))
      else resolve(stdout)
    })
  })
}

// A ref the user picked: never something git would read as an option.
const refOk = (r) => typeof r === 'string' && r.length > 0 && r.length <= 200 && !r.startsWith('-') && !/[\s\0~^:?*[\\]/.test(r)

// A commit of the working copy as it is now (changed, new and deleted files; not ignored ones),
// on top of HEAD. Built with a throwaway index, so your staging area, checkout and branches stay
// as they are. Returns HEAD itself when nothing is uncommitted.
async function snapshot(repo) {
  const head = (await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
  // A copy of the real index, next to it: it has the stat cache (so `add -A` only reads files
  // that changed) and what you staged, and split-index files are found from there.
  const real = path.resolve(repo, (await git(repo, ['rev-parse', '--git-path', 'index'])).trim())
  const index = `${real}.agent-control-${crypto.randomBytes(6).toString('hex')}`
  try {
    const env = { GIT_INDEX_FILE: index }
    if (fs.existsSync(real)) fs.copyFileSync(real, index)
    else await git(repo, ['read-tree', head], undefined, 0, env) // nothing ever staged
    await git(repo, ['add', '-A', '--', '.'], undefined, 60_000, env)
    const tree = (await git(repo, ['write-tree'], undefined, 0, env)).trim()
    if (tree === (await git(repo, ['rev-parse', `${head}^{tree}`])).trim()) return { sha: head, dirty: false }
    const who = { GIT_AUTHOR_NAME: 'Agent Control', GIT_AUTHOR_EMAIL: 'agent-control@localhost', GIT_COMMITTER_NAME: 'Agent Control', GIT_COMMITTER_EMAIL: 'agent-control@localhost' }
    const sha = (await git(repo, ['commit-tree', '--no-gpg-sign', tree, '-p', head, '-m', 'Uncommitted changes (snapshot for review)'], undefined, 0, who)).trim()
    return { sha, dirty: true }
  } finally {
    fs.rmSync(index, { force: true })
  }
}

function buildPrompt(r) {
  const range = `${r.mergeBase}..${r.headSha}`
  const ticket = r.ticket
    ? `\n## Ticket\nThe change is meant to do what this ticket describes. Check whether it does: say in "ticket" how well it is covered, and report anything missing or done differently as findings with category "ticket".\n\n<ticket>\n${r.ticket}\n</ticket>\n`
    : '\nNo ticket was given: leave out "ticket".\n'
  return `You are reviewing the changes on branch \`${r.branch}\` compared with \`${r.base}\`.
The working directory is a read-only checkout of the branch. Don't change any files.

## The change
- Commits: \`git log --oneline ${range}\`
- Diff: \`git diff ${range}\` (add \`-- <path>\` for one file)
- ${r.stat}
${r.uncommitted ? `- The last commit, "Uncommitted changes (snapshot for review)", is work in progress that isn't committed yet. Review it like the rest.\n` : ''}${ticket}
## What to look for
Correctness bugs, security problems, missed requirements, broken edge cases and error handling, and
risky changes without tests. Read the surrounding code and callers before you report something.
Not style, naming or formatting.

## How to report
- Only report what you have verified in the code. A few real findings beat many guesses; none is fine.
- "file" is relative to the repository root and "line" is a line in the new version of that file,
  inside or next to the changed code.
- "scenario" is concrete: which input or state, and what goes wrong.
- severity: high = will break something or is a security hole; medium = a real bug in a less common
  path or a clear gap; low = worth fixing but not urgent.
- Write in the language the ticket is written in, or English if there is no ticket.`
}

// The hunk of `diff` (one file, unified format) that holds new-side line `line`, or the nearest.
export function hunkFor(diff, line) {
  const hunks = []
  let cur
  for (const l of diff.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l)
    if (m) {
      cur = { header: l, oldStart: +m[1], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], lines: [] }
      hunks.push(cur)
    } else if (cur && (l.startsWith(' ') || l.startsWith('+') || l.startsWith('-'))) cur.lines.push(l)
  }
  if (!hunks.length) return undefined
  const dist = (h) => (line < h.newStart ? h.newStart - line : line >= h.newStart + h.newCount ? line - (h.newStart + h.newCount - 1) : 0)
  const best = typeof line === 'number' ? hunks.reduce((a, b) => (dist(b) < dist(a) ? b : a)) : hunks[0]
  if (typeof line === 'number' && dist(best) > 20) return undefined // about code the branch didn't touch
  return { header: best.header, oldStart: best.oldStart, newStart: best.newStart, lines: best.lines.slice(0, 120) }
}

function cleanFindings(out, worktree) {
  const list = Array.isArray(out?.findings) ? out.findings.slice(0, 60) : []
  // The agent may give absolute paths, through symlinks or not (/var vs /private/var on macOS).
  let real = worktree
  try {
    real = fs.realpathSync(worktree)
  } catch {}
  return list
    .map((f) => {
      let file = text(f?.file, 300)
      for (const root of [worktree, real]) if (file?.startsWith(root + '/')) file = file.slice(root.length + 1)
      file = file?.replace(/^\.\//, '')
      return {
        severity: SEVERITIES.includes(f?.severity) ? f.severity : 'medium',
        category: CATEGORIES.includes(f?.category) ? f.category : 'bug',
        file,
        line: Number.isInteger(f?.line) && f.line > 0 ? f.line : undefined,
        title: text(f?.title, 300),
        detail: text(f?.detail, 4000),
        scenario: text(f?.scenario, 2000),
        suggestion: text(f?.suggestion, 2000),
        status: 'open',
      }
    })
    .filter((f) => f.title)
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
    .map((f, i) => ({ id: `f${i + 1}`, ...f }))
}

export function createReviews({ dataDir, broadcast }) {
  const FILE = path.join(dataDir, 'reviews.json')
  /** @type {{repos: string[], reviews: object[]}} */
  // repos: added by hand. seen: repos that sessions ran in (from the hooks' cwd), newest first.
  // removed: repos you took off the list; hook events don't bring them back, only you do.
  let store = { repos: [], seen: [], removed: [], reviews: [] }
  // Session id -> the repo it runs in, for "Review changes" on an agent. A Map, so ids like
  // "constructor" or "__proto__" are just ids.
  const sessions = new Map()
  const procs = new Map() // review id -> child process

  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (Array.isArray(s?.repos)) store.repos = s.repos.filter((r) => typeof r === 'string')
    if (Array.isArray(s?.seen)) store.seen = s.seen.filter((r) => typeof r === 'string')
    if (Array.isArray(s?.removed)) store.removed = s.removed.filter((r) => typeof r === 'string')
    if (s?.sessions && typeof s.sessions === 'object' && !Array.isArray(s.sessions))
      for (const [id, repo] of Object.entries(s.sessions)) if (typeof repo === 'string') sessions.set(id, repo)
    if (Array.isArray(s?.reviews)) store.reviews = s.reviews.filter((r) => typeof r?.id === 'string')
  } catch {} // first run
  // Their process didn't survive the restart.
  const orphans = store.reviews.filter((r) => r.status === 'running')
  for (const r of orphans) {
    r.status = 'failed'
    r.error = 'The server restarted during the review'
    r.endedAt = Date.now()
    if (r.worktree) removeWorktree(r)
  }
  if (orphans.length) save()

  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify({ ...store, sessions: Object.fromEntries(sessions) }), { mode: 0o600 })
      fs.renameSync(`${FILE}.tmp`, FILE)
    } catch (e) {
      console.warn(`Could not save ${FILE}: ${e.message}`)
    }
  }

  // What every dashboard viewer may see; the findings and the ticket need the token.
  const summary = (r) => {
    const open = r.findings?.filter((f) => f.status !== 'dismissed') ?? [] // accepted still needs fixing
    return {
      id: r.id,
      repo: path.basename(r.repo),
      branch: r.branch,
      base: r.base,
      uncommitted: r.uncommitted || undefined,
      status: r.status,
      createdAt: r.createdAt,
      endedAt: r.endedAt,
      agentId: r.sessionId,
      verdict: r.verdict,
      counts: Object.fromEntries(SEVERITIES.map((s) => [s, open.filter((f) => f.severity === s).length])),
      total: r.findings?.length ?? 0,
    }
  }
  const publicList = () => store.reviews.map(summary)
  const changed = () => {
    save()
    broadcast({ type: 'reviews', reviews: publicList() })
  }

  async function removeWorktree(r) {
    try {
      await git(r.repo, ['worktree', 'remove', '--force', r.worktree])
    } catch {
      fs.rmSync(r.worktree, { recursive: true, force: true })
      await git(r.repo, ['worktree', 'prune']).catch(() => {})
    }
  }

  async function addRepo(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p.replace(/^~(?=\/)/, os.homedir())) || p.length > 500)
      throw new Error('Give the absolute path to a git repository')
    const top = (await git(p.replace(/^~(?=\/)/, os.homedir()), ['rev-parse', '--show-toplevel']).catch(() => {
      throw new Error(`Not a git repository: ${p}`)
    })).trim()
    unremove(top)
    if (!store.repos.includes(top)) store.repos.push(top)
    save()
    return top
  }

  // Repos you run agents in count as known: the hooks report each session's folder.
  const known = (repo) => store.repos.includes(repo) || store.seen.includes(repo)
  const worktreeRoots = () => {
    try {
      return [WORKTREES, fs.realpathSync(WORKTREES)]
    } catch {
      return [WORKTREES]
    }
  }
  const checked = new Map() // cwd -> its repo's top folder, or '' if none; once per server run
  // Saves what hook events change at most once a second: they come in bursts.
  let saveTimer
  const saveSoon = () => {
    saveTimer ??= setTimeout(() => {
      saveTimer = undefined
      save()
    }, 1000)
  }

  async function noteCwd(cwd, sessionId) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.length > 500) return
    const first = !checked.has(cwd) // the list order only changes the first time a folder is seen
    if (first) checked.set(cwd, git(cwd, ['rev-parse', '--show-toplevel']).then((t) => t.trim(), () => ''))
    const top = await checked.get(cwd)
    // A review's own checkout is not a repo to offer.
    if (!top || worktreeRoots().some((w) => top.startsWith(w + path.sep))) return
    let dirty = false
    if (typeof sessionId === 'string' && sessionId && sessionId.length <= 100 && sessions.get(sessionId) !== top) {
      sessions.delete(sessionId) // newest last, so the oldest go first
      sessions.set(sessionId, top)
      for (const id of [...sessions.keys()].slice(0, Math.max(0, sessions.size - 300))) sessions.delete(id)
      dirty = true
    }
    if (first && store.seen[0] !== top && !store.removed.includes(top)) {
      store.seen = [top, ...store.seen.filter((r) => r !== top)].slice(0, 50)
      dirty = true
    }
    if (dirty) saveSoon()
  }
  const unremove = (repo) => (store.removed = store.removed.filter((r) => r !== repo))
  // The repo a session ran in, offered again if it has since dropped off the list (or was removed).
  async function sessionRepo(id) {
    const repo = sessions.get(id)
    if (!repo) throw new Error("Don't know which repository this session is in")
    if (known(repo)) return repo
    const top = (await git(repo, ['rev-parse', '--show-toplevel']).catch(() => '')).trim()
    if (top !== repo) throw new Error(`${repo} is no longer a git repository`)
    unremove(repo) // you asked to review it
    store.seen = [repo, ...store.seen].slice(0, 50)
    save()
    return repo
  }

  const repoList = () => [
    ...store.repos.map((r) => ({ path: r, name: path.basename(r), source: 'added' })),
    ...store.seen.filter((r) => !store.repos.includes(r)).map((r) => ({ path: r, name: path.basename(r), source: 'session' })),
  ]

  // Fetches every remote so remote branches are current. Failing is fine (offline, no access):
  // the list is then what was fetched last, and the reason is shown.
  const fetched = new Map() // repo -> {at, error}
  async function fetchRepo(repo, force) {
    const last = fetched.get(repo)
    if (last && !force && Date.now() - last.at < FETCH_EVERY_MS) return last
    const remotes = (await git(repo, ['remote']).catch(() => '')).trim()
    if (!remotes) return { at: Date.now(), none: true }
    const r = await git(repo, ['fetch', '--all', '--prune', '--quiet'], undefined, FETCH_TIMEOUT_MS).then(
      () => ({ at: Date.now() }),
      (e) => ({ at: Date.now(), error: e.message }),
    )
    fetched.set(repo, r)
    return r
  }

  async function branches(repo, { fetch = false, force = false } = {}) {
    if (!known(repo)) throw new Error('Unknown repository')
    const f = fetch ? await fetchRepo(repo, force) : fetched.get(repo)
    const remotes = (await git(repo, ['remote']).catch(() => '')).split('\n').filter(Boolean)
    const out = await git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)\t%(objectname)\t%(committerdate:unix)', 'refs/heads', 'refs/remotes'])
    const refs = out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ref, sha, at] = l.split('\t')
        const remote = ref.startsWith('refs/remotes/')
        const name = ref.replace(/^refs\/(heads|remotes)\//, '')
        return { name, sha, at: Number(at) * 1000, remote }
      })
      .filter((b) => !(b.remote && (b.name.endsWith('/HEAD') || remotes.includes(b.name))))
    const bySha = new Map(refs.map((b) => [b.name, b.sha]))
    // The remote a local branch is compared with: its upstream, else the same name on origin.
    const upstreams = new Map(
      (await git(repo, ['for-each-ref', '--format=%(refname:short)\t%(upstream:short)', 'refs/heads']).catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('\t'))
        .filter(([, u]) => u),
    )
    const pairOf = (local) => {
      const u = upstreams.get(local)
      if (u && bySha.has(u)) return u
      const same = remotes.map((r) => `${r}/${local}`).find((n) => bySha.has(n))
      return same
    }
    const hidden = new Set() // remote branches identical to their local one
    const list = []
    for (const b of refs) {
      if (b.remote) continue
      const remote = pairOf(b.name)
      const entry = { name: b.name, at: b.at }
      if (remote) {
        if (bySha.get(remote) === b.sha) hidden.add(remote)
        else {
          const [ahead, behind] = (await git(repo, ['rev-list', '--left-right', '--count', `${b.sha}...${bySha.get(remote)}`]).catch(() => '0 0'))
            .trim()
            .split(/\s+/)
            .map(Number)
          Object.assign(entry, { remote, ahead, behind })
        }
      }
      list.push(entry)
    }
    for (const b of refs) if (b.remote && !hidden.has(b.name)) list.push({ name: b.name, at: b.at, remote: true })
    list.sort((a, b) => b.at - a.at)
    const names = new Set(list.map((b) => b.name))

    // Base: the remote's default branch, as the local copy unless that is behind the remote.
    const head = (await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim() // origin/main
    const candidates = [head.replace(/^origin\//, ''), 'main', 'master', 'develop', 'trunk'].filter(Boolean)
    let base = candidates.find((n) => names.has(n) || names.has(`origin/${n}`) || hidden.has(`origin/${n}`)) ?? list[0]?.name ?? ''
    const local = list.find((b) => b.name === base)
    if (!local && names.has(`origin/${base}`)) base = `origin/${base}`
    else if (local?.behind) base = local.remote
    const current = (await git(repo, ['branch', '--show-current']).catch(() => '')).trim()
    // Files changed, added or deleted and not committed (ignored ones don't count).
    const dirty = (await git(repo, ['status', '--porcelain']).catch(() => '')).split('\n').filter(Boolean).length
    return {
      branches: list,
      base,
      current,
      dirty,
      fetchedAt: f && !f.none ? f.at : undefined,
      fetchError: f?.error,
      hasRemote: remotes.length > 0,
    }
  }

  async function start(body) {
    const repo = body?.repo
    if (!known(repo)) throw new Error('Unknown repository: add it first')
    const { branch, base } = body
    if (!refOk(branch) || !refOk(base)) throw new Error('Pick a branch and a base branch')
    // true: include the uncommitted work (the branch must be checked out). 'auto' (Run again):
    // include it if the branch is still checked out, else review the branch as committed.
    const current = (await git(repo, ['branch', '--show-current']).catch(() => '')).trim()
    const withUncommitted = body.includeUncommitted === true || (body.includeUncommitted === 'auto' && current === branch)
    if (branch === base && !withUncommitted) throw new Error('The branch and the base are the same')
    if (procs.size >= MAX_RUNNING) throw new Error(`At most ${MAX_RUNNING} reviews can run at once`)
    const sha = (ref) => git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then((s) => s.trim(), () => { throw new Error(`No such branch: ${ref}`) })
    let headSha = await sha(branch)
    let uncommitted = false
    if (withUncommitted) {
      if (current !== branch) throw new Error(`Uncommitted changes can only be included for the checked-out branch${current ? ` (${current})` : ''}`)
      const snap = await snapshot(repo)
      headSha = snap.sha
      uncommitted = snap.dirty
    }
    const baseSha = await sha(base)
    const mergeBase = (await git(repo, ['merge-base', baseSha, headSha])).trim()
    if (mergeBase === headSha)
      throw new Error(withUncommitted ? `No changes: ${branch} is the same as ${base} and nothing is uncommitted` : `${branch} has no changes that aren't already in ${base}`)
    const stat = (await git(repo, ['diff', '--shortstat', mergeBase, headSha])).trim() || 'No file changes'

    const id = crypto.randomBytes(4).toString('hex')
    const slug = (s) => s.replace(/[^\w.-]+/g, '-').slice(0, 40)
    const r = {
      id,
      repo,
      branch,
      base,
      headSha,
      baseSha,
      mergeBase,
      stat,
      uncommitted,
      ticket: text(body.ticket, 20000),
      sessionId: crypto.randomUUID(),
      worktree: path.join(WORKTREES, `${slug(path.basename(repo))}-review-${slug(branch)}-${id}`),
      status: 'running',
      createdAt: Date.now(),
      findings: [],
    }
    fs.mkdirSync(WORKTREES, { recursive: true })
    await git(repo, ['worktree', 'add', '--detach', r.worktree, headSha])
    store.reviews.unshift(r)
    store.reviews = store.reviews.slice(0, MAX_REVIEWS)
    changed()
    run(r)
    return r
  }

  function finish(r, change) {
    procs.delete(r.id)
    if (r.status !== 'running') return // cancelled meanwhile
    Object.assign(r, change, { endedAt: Date.now() })
    removeWorktree(r).finally(changed)
  }

  function run(r) {
    const args = [
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(SCHEMA),
      '--session-id', r.sessionId,
      '--name', `Review: ${r.branch}`.slice(0, 40),
      '--permission-mode', 'dontAsk',
      '--allowedTools', ...ALLOWED_TOOLS,
      '--disallowedTools', ...DISALLOWED_TOOLS,
    ]
    let child
    try {
      child = spawn(CLAUDE, args, { cwd: r.worktree, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    } catch (e) {
      return finish(r, { status: 'failed', error: `Could not start ${CLAUDE}: ${e.message}` })
    }
    procs.set(r.id, child)
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out = (out + c).slice(-5_000_000)))
    child.stderr.on('data', (c) => (err = (err + c).slice(-4000)))
    child.stdin.on('error', () => {})
    child.stdin.end(buildPrompt(r))
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS).unref()
    child.on('error', (e) => {
      clearTimeout(timer)
      const missing = e.code === 'ENOENT'
      finish(r, {
        status: 'failed',
        error: missing
          ? `Could not find "${CLAUDE}". Review mode needs Claude Code installed where the server runs (not inside Docker).`
          : `Could not start ${CLAUDE}: ${e.message}`,
      })
    })
    child.on('close', async (code, signal) => {
      clearTimeout(timer)
      if (!procs.has(r.id)) return // 'error' already finished it
      let res
      try {
        res = JSON.parse(out)
      } catch {}
      const so = res?.structured_output
      if (!so || res.is_error) {
        const why = signal
          ? `Stopped after ${Math.round(TIMEOUT_MS / 60000)} minutes`
          : text(res?.result, 600) ?? text(err, 1500) ?? `claude exited with code ${code}`
        return finish(r, { status: 'failed', error: why, cost: res?.total_cost_usd })
      }
      const findings = cleanFindings(so, r.worktree)
      // The diff around each finding, from the commits (the worktree is about to go).
      const diffs = new Map()
      for (const f of findings) {
        if (!f.file) continue
        if (!diffs.has(f.file)) diffs.set(f.file, await git(r.repo, ['diff', '-U4', r.mergeBase, r.headSha, '--', f.file]).catch(() => ''))
        f.hunk = hunkFor(diffs.get(f.file), f.line)
      }
      finish(r, {
        status: 'done',
        summary: text(so.summary, 4000),
        verdict: VERDICTS.includes(so.verdict) ? so.verdict : 'comment',
        ticketCoverage:
          r.ticket && so.ticket && COVERAGE.includes(so.ticket.addressed)
            ? { addressed: so.ticket.addressed, notes: text(so.ticket.notes, 4000) }
            : undefined,
        findings,
        cost: typeof res.total_cost_usd === 'number' ? res.total_cost_usd : undefined,
        turns: res.num_turns,
      })
    })
  }

  function cancel(r) {
    const child = procs.get(r.id)
    procs.delete(r.id)
    child?.kill('SIGTERM')
    if (r.status === 'running') {
      Object.assign(r, { status: 'cancelled', endedAt: Date.now() })
      removeWorktree(r).finally(changed)
    }
  }

  const find = (id) => store.reviews.find((r) => r.id === id)
  // The full review, without where it ran on disk.
  const full = (r) => {
    const { worktree, ...rest } = r
    return { ...rest, ...summary(r), repoPath: r.repo }
  }

  function readJson(req, limit) {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > limit) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(undefined)
        }
      })
    })
  }

  // Routes under /api/review*; the caller has checked the token. Returns false if not ours.
  function handle(req, res, url, json, sameOrigin) {
    const p = url.pathname
    if (!p.startsWith('/api/review')) return false
    const write = req.method !== 'GET'
    if (write && !sameOrigin()) return req.resume(), json(403, { error: 'cross-origin' }), true
    const fail = (e) => json(400, { error: e.message })

    if (p === '/api/review/repos' && req.method === 'GET') return json(200, repoList()), true
    if (p === '/api/review/repos' && req.method === 'POST') {
      readJson(req, 4096).then(async (b) => {
        try {
          if (b?.remove) {
            store.repos = store.repos.filter((r) => r !== b.remove)
            store.seen = store.seen.filter((r) => r !== b.remove)
            if (typeof b.remove === 'string' && b.remove.length <= 500)
              store.removed = [b.remove, ...store.removed.filter((r) => r !== b.remove)].slice(0, 100)
            save()
            return json(200, { repos: repoList() })
          }
          const added = await addRepo(b?.path)
          json(200, { added, repos: repoList() })
        } catch (e) {
          fail(e)
        }
      })
      return true
    }
    if (p === '/api/review/branches' && req.method === 'GET') {
      const fetch = url.searchParams.get('fetch') // 1 = fetch if not done lately, force = fetch now
      branches(url.searchParams.get('repo') ?? '', { fetch: !!fetch, force: fetch === 'force' }).then((b) => json(200, b), fail)
      return true
    }
    if (p === '/api/reviews' && req.method === 'GET') return json(200, publicList()), true
    const sm = /^\/api\/review\/session\/([\w-]{1,100})$/.exec(p)
    if (sm && req.method === 'GET') {
      sessionRepo(sm[1]).then(
        (repo) => json(200, { repo, name: path.basename(repo) }),
        (e) => json(404, { error: e.message }),
      )
      return true
    }
    if (p === '/api/reviews' && req.method === 'POST') {
      readJson(req, 65536).then((b) => start(b).then((r) => json(200, full(r)), fail))
      return true
    }
    const m = /^\/api\/reviews\/(\w{1,16})(?:\/findings\/(\w{1,16}))?$/.exec(p)
    const r = m && find(m[1])
    if (m && !r) return req.resume(), json(404, { error: 'no such review' }), true
    if (m && !m[2] && req.method === 'GET') return json(200, full(r)), true
    if (m && !m[2] && req.method === 'DELETE') {
      cancel(r)
      store.reviews = store.reviews.filter((x) => x !== r)
      changed()
      return json(200, { ok: true }), true
    }
    if (m && !m[2] && req.method === 'POST') {
      // {cancel: true}: stop a running review but keep it in the list.
      readJson(req, 1024).then((b) => {
        if (!b?.cancel) return json(400, { error: 'expected {"cancel": true}' })
        cancel(r)
        json(200, full(r))
      })
      return true
    }
    if (m && m[2] && req.method === 'POST') {
      readJson(req, 1024).then((b) => {
        const f = r.findings?.find((x) => x.id === m[2])
        if (!f) return json(404, { error: 'no such finding' })
        if (!FINDING_STATUSES.has(b?.status)) return json(400, { error: 'status must be open | accepted | dismissed' })
        f.status = b.status
        changed()
        json(200, full(r))
      })
      return true
    }
    return req.resume(), json(404, { error: 'not found' }), true
  }

  function shutdown() {
    if (saveTimer) clearTimeout(saveTimer), save() // don't lose what a burst of events changed
    for (const c of procs.values()) c.kill('SIGTERM')
  }

  return { handle, publicList, noteCwd, shutdown }
}
