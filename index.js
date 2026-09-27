// dsh-genoffice-captain, host half.
// Spots the GenOffice task-list skills in a session, tells the browser half over a loopback event
// stream, launches GenOffice on request, and installs DSH-named copies of the two skills if missing.
import { spawn } from 'node:child_process'
import { cpSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-genoffice-captain'
export const inject = ['webServer']

export const API = '/api/genoffice-captain'
/** GenOffice_XLSX_Tasklist, /GenOfficeXLSXTasklistOrchestration and the DSH names genoffice-xlsx-tasklist(-orchestration). */
export const TRIGGER = /genoffice[_-]?xlsx[_-]?tasklist(?:[_-]?orchestration)?/i
/** Carried by the browser half's Captain notice so that notice does not trigger the pane again. */
export const MARKER = '(dsh-genoffice-captain)'
export const SKILLS = ['genoffice-xlsx-tasklist', 'genoffice-xlsx-tasklist-orchestration']
const HERE = dirname(fileURLToPath(import.meta.url))

export function apply(ctx, config = {}) {
  const skillsDir = join(config.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh'), 'skills')
  installSkills(skillsDir, ctx.logger)
  const streams = new Set()
  let last
  const fire = (agent, by) => {
    last = { at: Date.now(), by, sessionId: agent?.session?.id, cwd: agent?.session?.header?.cwd }
    for (const res of streams) res.write(`data: ${JSON.stringify(last)}\n\n`)
  }

  // Operator invocation: a user message that names either skill (typed name or /name gesture).
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision?.kind !== 'reject' && (messages ?? []).some(isTriggerMessage)) fire(agent, 'user')
    return decision
  })
  // Model invocation: the agent loaded either skill with the `skill` tool.
  ctx.on('tools/result', (exec) => {
    if (exec?.name === 'skill' && TRIGGER.test(JSON.stringify(exec.arguments ?? ''))) fire(exec.agent, 'model')
  })

  const routes = {
    events(req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      if (last && Date.now() - last.at < 60_000) res.write(`data: ${JSON.stringify(last)}\n\n`)
      streams.add(res)
      req.on('close', () => streams.delete(res))
    },
    status(req, res) {
      json(res, 200, { genoffice: findGenOffice(config) ?? null, skills: Object.fromEntries(SKILLS.map(s => [s, existsSync(join(skillsDir, s, 'SKILL.md'))])) })
    },
    launch(req, res) {
      // The custom header keeps other web pages from triggering a launch (it forces a CORS preflight nobody answers).
      if (req.method !== 'POST' || req.headers['x-genoffice-captain'] !== '1') return json(res, 400, { ok: false, error: 'POST with header x-genoffice-captain: 1' })
      json(res, 200, launch(config))
    },
  }
  for (const [route, handler] of Object.entries(routes)) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${API}/${route}`,
      handler: (req, res) => isLoopback(req) ? handler(req, res) : json(res, 403, { ok: false, error: 'loopback only' }),
    }))
  }
  ctx.effect(() => () => { for (const res of streams) res.end() })
}

function isTriggerMessage(message) {
  if (message?.source?.kind !== 'user') return false
  const text = (message.content ?? []).map(b => (b.type === 'text' ? b.text : '')).join('\n')
  return TRIGGER.test(text) && !text.includes(MARKER)
}

/** GenOffice app path on this machine; config.genofficePath or GENOFFICE_PATH override the guesses. */
export function findGenOffice(config = {}, env = process.env, platform = process.platform) {
  const guesses = platform === 'darwin'
    ? ['/Applications/GenOffice.app', join(homedir(), 'Applications', 'GenOffice.app')]
    : platform === 'win32'
      ? [join(env.LOCALAPPDATA ?? '', 'Programs', 'GenOffice', 'GenOffice.exe'), join(env.ProgramFiles ?? 'C:\\Program Files', 'GenOffice', 'GenOffice.exe')]
      : ['/opt/GenOffice/genoffice', '/usr/bin/genoffice', '/usr/local/bin/genoffice', join(homedir(), 'Applications', 'GenOffice.AppImage')]
  return [config.genofficePath, env.GENOFFICE_PATH, ...guesses].find(p => p && existsSync(p))
}

/** Start GenOffice, or bring the running instance forward. */
export function launch(config = {}) {
  const app = findGenOffice(config)
  if (!app) return { ok: false, error: 'GenOffice is not installed (https://github.com/genspark-ai/genoffice); set genofficePath if it lives elsewhere' }
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-a', app]] : [app, []]
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
  return { ok: true, app }
}

function installSkills(dir, logger) {
  for (const skill of SKILLS) {
    const dest = join(dir, skill)
    if (existsSync(dest)) continue // never overwrite the user's copy
    try { cpSync(join(HERE, 'skills', skill), dest, { recursive: true }) } catch (e) { logger?.warn?.(`${name}: could not install skill ${skill}: ${e.message}`) }
  }
}

function isLoopback(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
