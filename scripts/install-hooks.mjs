// Installs (or with --uninstall removes) Agent Control hooks for Claude Code and Codex.
// Usage: npm run install-hooks [-- --url http://localhost:3000] [-- --uninstall]
//                              [-- --claude-only | --codex-only]
// Each tool is set up when its config folder exists (~/.claude, ~/.codex); Claude Code also when
// neither does. Works on Windows and macOS/Linux. Existing settings are preserved; a one-time
// backup of each file is kept.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const uninstall = args.includes('--uninstall')
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:3000'

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const codexDir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const acDir = path.join(os.homedir(), '.agent-control')
const hookPath = path.join(acDir, 'hook.mjs')
const cfgPath = path.join(acDir, 'config.json')

// The Node running this script, by full path: apps started from the Dock or Finder often don't
// have version managers like nvm on their PATH, so plain `node` would fail there (silently,
// since the hook never reports errors). Re-run the installer after removing this Node version.
// Forward slashes + quotes work under bash and PowerShell alike.
const slash = (p) => p.replace(/\\/g, '/')
const command = `"${slash(process.execPath)}" "${slash(hookPath)}"`
const isOurs = (h) => typeof h?.command === 'string' && h.command.replace(/\\/g, '/').includes('.agent-control/hook.mjs')

const TARGETS = [
  {
    name: 'Claude Code',
    dir: claudeDir,
    file: path.join(claudeDir, 'settings.json'),
    events: [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure',
      'PermissionRequest', 'Stop', 'SubagentStart', 'SubagentStop',
    ],
    // PermissionRequest waits for an answer from the dashboard (up to 120s, see the hook).
    handler: (ev) => ({ type: 'command', command, timeout: ev === 'PermissionRequest' ? 130 : 5 }),
  },
  {
    name: 'Codex',
    dir: codexDir,
    file: path.join(codexDir, 'hooks.json'),
    events: [
      'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest',
      'Stop', 'SubagentStart', 'SubagentStop', 'PostModelRequest', 'Interrupt',
    ],
    handler: (ev) => ({
      type: 'command',
      command: `${command} codex`,
      // Codex caps these two at 3 seconds.
      timeout: ev === 'SessionEnd' || ev === 'Interrupt' ? 3 : ev === 'PermissionRequest' ? 130 : 5,
      // Usage reports don't change state, so they needn't hold up the next request.
      ...(ev === 'PostModelRequest' ? { async: true } : {}),
    }),
  },
]

const exists = (d) => fs.existsSync(d)
const selected = args.includes('--claude-only')
  ? [TARGETS[0]]
  : args.includes('--codex-only')
    ? [TARGETS[1]]
    : TARGETS.filter((t) => exists(t.dir)).length
      ? TARGETS.filter((t) => exists(t.dir))
      : [TARGETS[0]]

// Read every file first, so one we can't parse stops the whole run before anything changes.
const plans = selected.map((t) => {
  let settings = {}
  if (fs.existsSync(t.file)) {
    try {
      settings = JSON.parse(fs.readFileSync(t.file, 'utf8'))
    } catch (e) {
      console.error(`Cannot parse ${t.file} (${e.message}). Nothing was changed.`)
      process.exit(1)
    }
  }
  return { ...t, settings }
})

// Merge: remove our previous entries, then add one per event (unless uninstalling).
function merge(settings, { events, handler }) {
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  for (const ev of new Set([...events, ...Object.keys(hooks)])) {
    const groups = Array.isArray(hooks[ev]) ? hooks[ev] : []
    const kept = []
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) {
        kept.push(g)
        continue
      }
      const rest = g.hooks.filter((h) => !isOurs(h))
      if (rest.length === g.hooks.length) kept.push(g)
      else if (rest.length) kept.push({ ...g, hooks: rest })
    }
    if (!uninstall && events.includes(ev)) kept.push({ hooks: [handler(ev)] })
    if (kept.length) hooks[ev] = kept
    else delete hooks[ev]
  }
  if (Object.keys(hooks).length) settings.hooks = hooks
  else delete settings.hooks
}

for (const t of plans) {
  merge(t.settings, t)
  fs.mkdirSync(t.dir, { recursive: true })
  const backup = t.file + '.agent-control.bak'
  if (fs.existsSync(t.file) && !fs.existsSync(backup)) fs.copyFileSync(t.file, backup)
  fs.writeFileSync(t.file + '.tmp', JSON.stringify(t.settings, null, 2) + '\n')
  fs.renameSync(t.file + '.tmp', t.file)
  console.log(`${uninstall ? 'Removed Agent Control hooks from' : 'Hooks installed in'} ${t.file} (${t.name})`)
}
if (uninstall) process.exit(0)

// Hook script + shared config (token is created once and reused).
fs.mkdirSync(acDir, { recursive: true })
fs.copyFileSync(path.join(projectDir, 'hooks', 'claude-hook.mjs'), hookPath)
let cfg = {}
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
} catch {}
// approvalWaitSeconds: how long an approval waits for the dashboard before the normal prompt (0 = off).
cfg = { ...cfg, url, token: cfg.token || crypto.randomBytes(24).toString('hex'), approvalWaitSeconds: cfg.approvalWaitSeconds ?? 60 }
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })

// Give the server the same token via .env (read by `npm start` and docker compose).
const envPath = path.join(projectDir, '.env')
const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : []
const env = lines.filter((l) => l && !l.startsWith('AGENT_CONTROL_TOKEN='))
env.push(`AGENT_CONTROL_TOKEN=${cfg.token}`)
fs.writeFileSync(envPath, env.join('\n') + '\n')

console.log(`Hook script: ${hookPath} (run with ${process.execPath})\nServer token written to ${envPath}`)
console.log('If you remove or switch this Node version, run the installer again.')
if (plans.some((t) => t.name === 'Codex')) {
  // hooks.json and inline [hooks] in config.toml both load; Codex warns when a folder has both.
  try {
    if (/^\s*\[\[?hooks[.\]]/m.test(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')))
      console.log(`Note: ${path.join(codexDir, 'config.toml')} also declares hooks. Codex runs both and warns at startup.`)
  } catch {}
  console.log(
    'Codex skips the Agent Control hooks until you trust them: in the Codex app open Settings > Hooks ' +
      '(or click Review hooks in the message box); in the Codex CLI run /hooks.',
  )
}
console.log('Start Agent Control (docker compose up --build  or  npm start), then start a new session.')
