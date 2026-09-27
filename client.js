// dsh-genoffice-captain, browser half (DSH Web and DSH Desktop), in the client module format DSH loads:
// a classic script that registers one factory with window.__ModuleLoader__ (no ES module syntax allowed).
// On a GenOffice task-list trigger: one active session -> launch GenOffice; several -> open the
// DESIGNATE THE CAPTAIN pane over the right quarter of the window. Designating stars the chosen session,
// tells it in text that it is the Captain and launches GenOffice; the No Orchestration switch just launches.
window.__ModuleLoader__.load({
  id: 'dsh-genoffice-captain',
  factory: () => {
    const API = '/api/genoffice-captain'
    const STAR = '\u2B50'
    const PANE = 'dsh-genoffice-captain'
    // ponytail: "open and active" = running now or used in the last 6 hours; widen if a session you want is missing.
    const ACTIVE_MS = 6 * 60 * 60 * 1000
    const NOTICE = `/genoffice-xlsx-tasklist-orchestration ${STAR} The operator designated this session the Captain for the GenOffice task list (dsh-genoffice-captain). Reply "I am the Captain for <session>", keep the board in the project's GenOffice_XLSX_Tasklist folder, and brief the other sessions through this harness's messaging (see the skill's references/harness-messaging.md).`

    /** Top-level, non-blank sessions that are running or recently used, running first; `keep` (the triggering session) always counts. */
    function activeSessions(state, now = Date.now(), keep) {
      return (state?.ids ?? []).map(id => state.byId?.[id])
        .filter(s => s && !s.parentId && s.origin !== 'subagent' && (s.id === keep || (!s.blank && (s.running || now - s.updatedAt < ACTIVE_MS))))
        .sort((a, b) => Number(b.running) - Number(a.running) || b.updatedAt - a.updatedAt)
    }
    const isCaptain = s => (s?.title ?? '').startsWith(STAR)
    const unstar = t => t.replace(/^\u2B50\uFE0F?\s*/u, '')
    // A session is named by its own title, never by displayTitle: DSH falls back to the working-folder name there.
    const sessionName = s => s.title || `Untitled session ${String(s.id).replace(/^session-/, '').slice(0, 8)}`
    const ago = ms => (ms < 60e3 ? 'now' : ms < 3600e3 ? `${Math.floor(ms / 60e3)}m` : ms < 86400e3 ? `${Math.floor(ms / 3600e3)}h` : `${Math.floor(ms / 86400e3)}d`)
    const label = (s, now = Date.now()) => `${s.running ? '\u25CF' : '\u25CB'} ${sessionName(s)} \u00B7 ${ago(now - s.updatedAt)}`
    const fail = m => { throw new Error(m) }
    const launch = () => fetch(`${API}/launch`, { method: 'POST', headers: { 'x-genoffice-captain': '1' } })
      .then(r => r.json()).catch(e => ({ ok: false, error: e.message }))

    // A plugin apply that throws takes the whole DSH GUI down, so every failure is logged instead.
    function apply(ctx) {
      try { start(ctx) } catch (err) { console.error('[dsh-genoffice-captain]', err) }
    }

    function start(ctx) {
      const sessions = ctx.get('sessions')
      let memory = {} // { lastAt, solo: [sessionId, ...] }
      try { memory = JSON.parse(localStorage.getItem(PANE) ?? '{}') } catch {}
      const save = () => localStorage.setItem(PANE, JSON.stringify(memory))
      const events = new EventSource(`${API}/events`)
      events.onmessage = (e) => {
        try {
          const t = JSON.parse(e.data)
          if (t.at <= (memory.lastAt ?? 0)) return
          memory.lastAt = t.at
          save()
          onTrigger(t)
        } catch (err) { console.error('[dsh-genoffice-captain]', err) }
      }
      ctx.effect(() => () => { events.close(); document.getElementById(PANE)?.remove() })

      function onTrigger(t) {
        const list = activeSessions(sessions.list.getSnapshot(), Date.now(), t.sessionId)
        // Solo: one active session, or the operator already chose No Orchestration for this session.
        if (list.length <= 1 || memory.solo?.includes(t.sessionId)) return void launch().then(r => r.ok || toast(r.error))
        const captain = list.find(isCaptain)
        if (t.by === 'model' && captain) return // the board already has a Captain; only the operator reopens the pane
        openPane(list, captain?.id ?? t.sessionId, t.sessionId)
      }

      function openPane(list, selected, origin) {
        document.getElementById(PANE)?.remove()
        const pane = document.createElement('aside')
        pane.id = PANE
        pane.setAttribute('role', 'dialog')
        pane.setAttribute('aria-label', 'Designate the Captain')
        pane.innerHTML = `<style>${CSS.replaceAll('#P', '#' + PANE)}</style>
<header>DESIGNATE THE CAPTAIN ${STAR}</header>
<button class="x" title="Close" aria-label="Close">\u00D7</button>
<label class="solo"><input type="checkbox" role="switch"><span></span>No Orchestration</label>
<label>$ captain<select></select></label>
<button class="go">Designate ${STAR} and launch GenOffice</button>
<pre></pre>`
        const $ = s => pane.querySelector(s)
        const select = $('select'), go = $('.go'), solo = $('.solo input'), log = $('pre')
        for (const s of list) {
          const option = new Option(label(s), s.id, false, s.id === selected)
          option.title = s.cwd ?? '' // working folder only as a tooltip
          select.add(option)
        }
        const say = line => { log.textContent += `${line}\n` }
        const close = (ms = 0) => setTimeout(() => pane.remove(), ms)
        $('.x').onclick = () => close()
        pane.onkeydown = e => { if (e.key === 'Escape') close() }
        solo.onchange = async () => {
          select.disabled = go.disabled = solo.checked
          memory.solo = (memory.solo ?? []).filter(id => id !== origin)
          if (solo.checked) memory.solo = [...memory.solo, origin].slice(-50)
          save()
          if (!solo.checked) return
          const r = await launch()
          say(r.ok ? `no orchestration: launched ${r.app}` : `! ${r.error}`)
          if (r.ok) close(1500)
        }
        go.onclick = async () => {
          go.disabled = solo.disabled = true
          try { await designate(select.value, list, say); close(1500) } catch (err) { say(`! ${err.message}`); go.disabled = solo.disabled = false }
        }
        fetch(`${API}/status`).then(r => r.json()).then(s => {
          say(s.genoffice ? `genoffice ${s.genoffice}` : '! GenOffice is not installed')
          for (const [skill, ok] of Object.entries(s.skills ?? {})) say(`${ok ? 'skill' : '! missing skill'} ${skill}`)
        }).catch(() => {})
        document.body.append(pane)
        select.focus()
      }

      async function designate(id, list, say) {
        const face = sid => sessions.binding(sid)?.session ?? fail(`session ${sid} is not available`)
        const check = r => (r?.ok === false ? fail(r.error?.message ?? JSON.stringify(r.error)) : r)
        for (const s of list) {
          if (s.id === id || !isCaptain(s)) continue // exactly one Captain: take the star off the previous one
          check(await face(s.id).rename(unstar(s.title)))
          say(`unstarred ${unstar(s.title)}`)
        }
        const c = list.find(s => s.id === id)
        if (!isCaptain(c)) check(await face(id).rename(`${STAR} ${c.title || 'Captain'}`))
        check(await face(id).prompt([{ type: 'text', text: NOTICE }], 'queue'))
        say(`${STAR} ${sessionName(c)} is the Captain`)
        const r = await launch()
        say(r.ok ? `launched ${r.app}` : `! ${r.error}`)
      }
    }

    function toast(text) {
      const t = Object.assign(document.createElement('div'), { textContent: `GenOffice: ${text}` })
      t.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:40vw;padding:10px 14px;border-radius:6px;background:#3b1219;color:#ffd7dc;font:13px ui-monospace,Menlo,Consolas,monospace'
      document.body.append(t)
      setTimeout(() => t.remove(), 8000)
    }

    const CSS = `
#P{position:fixed;inset:0 0 0 auto;width:25vw;min-width:280px;z-index:2147483000;display:flex;flex-direction:column;gap:14px;padding:18px 16px;box-sizing:border-box;background:#0b0e12;color:#d7dde4;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border-left:1px solid #2a3139;box-shadow:-8px 0 24px #0009}
#P header{font-weight:700;letter-spacing:.08em;color:#f5c542;padding-right:24px}
#P label{display:flex;flex-direction:column;gap:6px;color:#7ee787}
#P select,#P .go{font:inherit;color:inherit;background:#141a21;border:1px solid #2f3842;border-radius:6px;padding:7px 9px}
#P .go{background:#1f3d2b;border-color:#2ea043;cursor:pointer}
#P .go:disabled,#P select:disabled{opacity:.45;cursor:default}
#P .x{position:absolute;top:10px;right:12px;border:0;background:none;color:#8b949e;font-size:20px;cursor:pointer}
#P .solo{flex-direction:row;align-items:center;gap:10px;color:#d7dde4;cursor:pointer}
#P .solo input{position:absolute;opacity:0;width:1px;height:1px}
#P .solo span{position:relative;flex:none;width:51px;height:31px;border-radius:31px;background:#39414b;transition:background .2s}
#P .solo span::after{content:'';position:absolute;top:2px;left:2px;width:27px;height:27px;border-radius:50%;background:#fff;box-shadow:0 2px 4px #0006;transition:transform .2s}
#P .solo input:checked+span{background:#34c759}
#P .solo input:checked+span::after{transform:translateX(20px)}
#P .solo input:focus-visible+span{outline:2px solid #58a6ff;outline-offset:2px}
#P pre{margin:0;white-space:pre-wrap;color:#8b949e;flex:1;overflow:auto}`

    return { name: 'dsh-genoffice-captain', inject: ['sessions'], apply, activeSessions, isCaptain, label, NOTICE }
  },
})
