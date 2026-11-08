// Installs (or with --uninstall removes) Agent Control hooks in Claude Code's user settings.
// Usage: npm run install-hooks [-- --url http://localhost:3000] [-- --uninstall]
// Works on Windows and macOS/Linux. Existing settings are preserved; a one-time backup is kept.
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
const settingsPath = path.join(claudeDir, 'settings.json')
const acDir = path.join(os.homedir(), '.agent-control')
const hookPath = path.join(acDir, 'hook.mjs')
const cfgPath = path.join(acDir, 'config.json')

const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Stop', 'SubagentStart', 'SubagentStop',
]
// Forward slashes + quotes work for node under bash and PowerShell alike.
const command = `node "${hookPath.replace(/\\/g, '/')}"`
const isOurs = (h) => typeof h?.command === 'string' && h.command.replace(/\\/g, '/').includes('.agent-control/hook.mjs')

// Read existing settings; refuse to touch a file we can't parse.
let settings = {}
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch (e) {
    console.error(`Cannot parse ${settingsPath} (${e.message}). Nothing was changed.`)
    process.exit(1)
  }
}

// Merge: remove our previous entries, then add one per event (unless uninstalling).
const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
for (const ev of EVENTS) {
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
  if (!uninstall) kept.push({ hooks: [{ type: 'command', command, timeout: 5 }] })
  if (kept.length) hooks[ev] = kept
  else delete hooks[ev]
}
if (Object.keys(hooks).length) settings.hooks = hooks
else delete settings.hooks

fs.mkdirSync(claudeDir, { recursive: true })
const backup = settingsPath + '.agent-control.bak'
if (fs.existsSync(settingsPath) && !fs.existsSync(backup)) fs.copyFileSync(settingsPath, backup)
fs.writeFileSync(settingsPath + '.tmp', JSON.stringify(settings, null, 2) + '\n')
fs.renameSync(settingsPath + '.tmp', settingsPath)

if (uninstall) {
  console.log(`Removed Agent Control hooks from ${settingsPath}`)
  process.exit(0)
}

// Hook script + shared config (token is created once and reused).
fs.mkdirSync(acDir, { recursive: true })
fs.copyFileSync(path.join(projectDir, 'hooks', 'claude-hook.mjs'), hookPath)
let cfg = {}
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
} catch {}
cfg = { url, token: cfg.token || crypto.randomBytes(24).toString('hex') }
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })

// Give the server the same token via .env (read by `npm start` and docker compose).
const envPath = path.join(projectDir, '.env')
const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : []
const env = lines.filter((l) => l && !l.startsWith('AGENT_CONTROL_TOKEN='))
env.push(`AGENT_CONTROL_TOKEN=${cfg.token}`)
fs.writeFileSync(envPath, env.join('\n') + '\n')

console.log(`Hooks installed in ${settingsPath}`)
console.log(`Hook script: ${hookPath}\nServer token written to ${envPath}`)
console.log('Start Agent Control (docker compose up --build  or  npm start), then start a new Claude Code session.')
