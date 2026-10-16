// idle-mod
// Fills Claude Code's wait state with facts about your own project.
// No telemetry, no server, no model calls; only npm talks to its registry.

const PANE = 'idle-mod'
const MAX_AGE_MS = 30 * 60 * 1000
const ROTATE_MS = 12000
const KEEP_PROJECTS = 20

// Severity sets the order in the pane; the band rotates through every line.
const SEV = { high: 0, warn: 1, info: 2 }

// Module state. Lost on reload, rebuilt by the next session.start.
let insights = []
let collectedAt = 0
let collecting = false
let busy = false
let interactive = true
// The finding whose prompt the pane shows in full, by its text; null for none.
let previewed = null
// The project the findings belong to: `top` runs git, `npm` runs the npm checks.
let where = { top: '', npm: '' }

// A cloned repo's .git/config names programs for git to run. These overrides
// keep the checks from running one: core.fsmonitor (run by git grep) and
// gpg.program (run by git log and friends when log.showSignature is on).
const GIT = ['git', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false']
const NPM_SAFE = '--git=git'

// Names and versions come from the project's own files and end up in a prompt
// sent as the user, so they are used only when they look like what npm writes.
const PKG_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,213}$/
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]{1,20})?(\+[0-9A-Za-z.]{1,20})?$/

// Text from the repo that is shown but never sent: printable ASCII only.
const safe = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 40)

// --------------------------------------------------------------- collectors
// Each collector returns a list of { severity, text, fix }, or null when a
// check could not run (a timeout, unreadable output): the previous lines of
// that collector then stay. None of them throws.

async function run($, argv, cwd, timeoutMs) {
  try {
    return await $.process.run(argv, { cwd, timeoutMs })
  } catch {
    return null
  }
}

async function exists($, path) {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

// The git top level when the session started inside a repo's subfolder,
// otherwise the session's own root. A monorepo package that has its own
// package.json is where the npm checks run.
async function locate($) {
  let root
  try {
    root = await $.session.root()
  } catch {
    return null
  }
  const r = await run($, [...GIT, 'rev-parse', '--show-toplevel'], root, 5000)
  const top = r && r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : root
  const npm = (await exists($, `${root}/package.json`)) ? root : top
  return { top, npm }
}

// $.store is one file shared by every project, so each project gets its key.
const scanKey = (w) => 'lastScan:' + w.npm

// Point the mod at the session's project. After /cd or a worktree move the
// old project's lines go, and the new project's last scan shows right away.
async function follow($) {
  const w = await locate($)
  if (!w || (w.top === where.top && w.npm === where.npm)) return
  where = w
  insights = []
  collectedAt = 0
  try {
    const saved = await $.store.get(scanKey(w))
    if (saved && Array.isArray(saved.insights)) {
      insights = saved.insights
      collectedAt = Number(saved.at) || 0
    }
  } catch {
    // no saved scan: the next one fills in
  }
}

async function npmInsights($, w) {
  if (!(await exists($, `${w.npm}/package.json`))) return []

  // A project's .npmrc can point npm at any host and fill its values from
  // environment variables, so a cloned repo could make npm send your tokens
  // there. npm has no switch to ignore it, so such projects are not checked.
  if ((await exists($, `${w.npm}/.npmrc`)) || (await exists($, `${w.top}/.npmrc`))) {
    return [{ severity: 'info', text: 'npm checks skipped: this project has its own .npmrc' }]
  }

  const [audit, outdated] = await Promise.all([
    run($, ['npm', 'audit', '--json', NPM_SAFE], w.npm, 30000),
    run($, ['npm', 'outdated', '--json', NPM_SAFE], w.npm, 60000),
  ])
  if (!audit || !outdated) return null

  const out = []
  try {
    const vulns = JSON.parse(audit.stdout).metadata.vulnerabilities
    const critical = Number(vulns.critical) || 0
    const high = Number(vulns.high) || 0
    const moderate = Number(vulns.moderate) || 0
    if (critical + high > 0) {
      out.push({
        severity: 'high',
        text: `npm audit: ${critical} critical, ${high} high severity`,
        fix: "Run npm audit, explain each high or critical finding and propose a fix for each. Don't change or install anything until I say so.",
      })
    } else if (moderate) {
      out.push({ severity: 'info', text: `npm audit: ${moderate} moderate, nothing critical` })
    }
  } catch {
    return null
  }

  if (outdated.stdout.trim()) {
    try {
      const major = (v) => Number(v.split('.')[0])
      const majors = Object.entries(JSON.parse(outdated.stdout)).filter(
        ([name, d]) =>
          d &&
          !Array.isArray(d) &&
          PKG_NAME.test(name) &&
          VERSION.test(d.current) &&
          VERSION.test(d.latest) &&
          major(d.latest) > major(d.current),
      )
      if (majors.length) {
        const [name, d] = majors[0]
        const rest = majors.length > 1 ? ` (+${majors.length - 1} more)` : ''
        out.push({
          severity: 'warn',
          text: `major update: ${name} ${d.current} → ${d.latest}${rest}`,
          fix: `Check what would break if ${name} went from ${d.current} to ${d.latest}. Tell me first; don't change or install anything until I say so.`,
        })
      }
    } catch {
      return null
    }
  }
  return out
}

async function gitInsights($, w) {
  if (!(await exists($, `${w.top}/.git`))) return []

  const [ahead, stash, branches] = await Promise.all([
    run($, [...GIT, 'rev-list', '--count', '@{u}..HEAD'], w.top, 8000),
    run($, [...GIT, 'stash', 'list'], w.top, 8000),
    run(
      $,
      [...GIT, 'for-each-ref', '--sort=committerdate', '--format=%(HEAD)|%(committerdate:unix)|%(refname:short)', 'refs/heads/'],
      w.top,
      8000,
    ),
  ])
  if (!ahead || !stash || !branches) return null

  const out = []
  // No upstream, a detached HEAD or no commits yet: rev-list fails, no line.
  const n = ahead.exitCode === 0 ? Number(ahead.stdout.trim()) || 0 : 0
  if (n > 0) {
    out.push({
      severity: 'warn',
      text: `${n} unpushed commit${n > 1 ? 's' : ''} on this branch`,
      fix: 'Show me the unpushed commits on this branch and tell me whether they look ready to push.',
    })
  }

  const stashes = stash.stdout.trim() ? stash.stdout.trim().split('\n').length : 0
  if (stashes) out.push({ severity: 'info', text: `${stashes} stash${stashes > 1 ? 'es' : ''} sitting around` })

  // A branch name may hold `|`, so it goes last; the checked-out one never counts.
  const cutoff = Date.now() / 1000 - 30 * 86400
  const stale = branches.stdout
    .split('\n')
    .map((l) => {
      const i = l.indexOf('|')
      const j = l.indexOf('|', i + 1)
      return { head: l.slice(0, i), at: Number(l.slice(i + 1, j)), name: l.slice(j + 1) }
    })
    .filter((b) => b.name && b.head !== '*' && b.at < cutoff)
  if (stale.length) {
    out.push({
      severity: 'info',
      text: `${stale.length} branch${stale.length > 1 ? 'es' : ''} untouched 30+ days (e.g. ${safe(stale[0].name)})`,
    })
  }
  return out
}

async function debtInsights($, w) {
  if (!(await exists($, `${w.top}/.git`))) return []

  // git grep stays inside tracked files, so node_modules and build output
  // never enter the count. It counts lines that hold the marker.
  const [fixme, todo] = await Promise.all([
    run($, [...GIT, 'grep', '-cI', '-e', 'FIXME'], w.top, 10000),
    run($, [...GIT, 'grep', '-cI', '-e', 'TODO'], w.top, 10000),
  ])
  if (!fixme || !todo) return null

  const total = (res) =>
    res.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .reduce((sum, line) => sum + (Number(line.split(':').pop()) || 0), 0)

  const out = []
  const nFixme = total(fixme)
  const nTodo = total(todo)
  if (nFixme) {
    out.push({
      severity: 'warn',
      text: `${nFixme} FIXME marker${nFixme > 1 ? 's' : ''} in tracked files`,
      fix: 'Find the FIXME markers, group them by theme, and tell me which ones are worth fixing now.',
    })
  }
  if (nTodo) out.push({ severity: 'info', text: `${nTodo} TODO marker${nTodo > 1 ? 's' : ''} across the project` })
  return out
}

// Keep the last few projects only; the store is one file shared by all of them.
async function remember($, w) {
  const key = scanKey(w)
  await $.store.set(key, { at: collectedAt, insights })
  const seen = await $.store.get('recent')
  const recent = [key, ...(Array.isArray(seen) ? seen.filter((k) => k !== key) : [])]
  for (const old of recent.slice(KEEP_PROJECTS)) await $.store.delete(old)
  await $.store.set('recent', recent.slice(0, KEEP_PROJECTS))
}

function redraw($) {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // nothing drawing
  }
}

// Never rejects, so callers may leave it unawaited.
async function collect($) {
  if (collecting || !interactive) return
  collecting = true
  let w = null
  try {
    await follow($)
    w = where
    if (!w.top) return
    const sources = ['npm', 'git', 'debt']
    const groups = await Promise.all([npmInsights($, w), gitInsights($, w), debtInsights($, w)])
    if (w !== where) return
    insights = groups
      .flatMap((g, i) => (g ? g.map((item) => ({ ...item, source: sources[i] })) : insights.filter((item) => item.source === sources[i])))
      .sort((a, b) => SEV[a.severity] - SEV[b.severity])
    collectedAt = Date.now()
    await remember($, w)
  } catch {
    // a failed scan keeps whatever the last good one found
  } finally {
    collecting = false
    redraw($)
    // The session moved to another project mid-scan: scan that one too.
    if (w && w !== where) collect($)
  }
}

function isStale() {
  return Date.now() - collectedAt > MAX_AGE_MS
}

// ------------------------------------------------------------------ drawing

const DOT = { high: 'red', warn: 'yellow', info: 'gray' }

function current() {
  if (!insights.length) return null
  return insights[Math.floor(Date.now() / ROTATE_MS) % insights.length]
}

// Whether anything draws this session. The desktop app hosts its Code tab as
// an SDK session (isInteractive false) and attaches its surface, so a surface
// counts as much as a person at the prompt. claude -p and CI have neither.
async function drawn($) {
  try {
    return (await $.session.surfaces()).length > 0
  } catch {
    return false
  }
}

// The first time the session turns out to draw: show the saved scan, refresh.
async function wake($) {
  if (interactive) return
  interactive = true
  await follow($)
  collect($)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    // Headless runs draw nothing, so they scan nothing.
    interactive = false

    // Rotate the band while Claude is busy. Cheap: one redraw, no work.
    $.clock.every(ROTATE_MS, () => {
      if (busy && insights.length) redraw($)
    })

    try {
      await $.command.register({ name: 'idle-mod', description: 'Open the idle-mod pane' })
    } catch {
      // name taken: the pane is still reachable from the band
    }

    if (e.isInteractive !== false || (await drawn($))) await wake($)
    return next(e)
  })

  // The desktop app may attach after the session started.
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    await wake($)
    return result
  })

  // A turn is the wait state. Refresh if the project moved or the scan is old.
  // Subagent turns fire these events too; only the main turn counts.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (!interactive && (await drawn($))) await wake($)
    if (!interactive) return next(e)
    busy = true
    await follow($)
    if (isStale()) collect($)
    redraw($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    busy = false
    redraw($)
    return next(e)
  })

  on('command.run', { command: 'idle-mod' }, async ($) => {
    // Someone ran the command, so something draws.
    interactive = true
    await follow($)
    if (isStale()) collect($)
    await $.ui.open({ id: PANE, title: 'idle-mod', focus: true, closeOnEscape: true })
    return {}
  })

  // The band above the prompt: one line, only while Claude is working.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!e.props.isWorking || e.props.hasSurvey) return next(e)
    const item = current()
    if (!item) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ children: ['◈'], color: DOT[item.severity] }),
        Text({ children: [item.text], dimColor: item.severity === 'info' }),
        Button({
          key: 'open-pane',
          label: 'details',
          hotkey: 'i',
          plain: true,
          dimColor: true,
          onPress: async () => {
            await $.ui.open({ id: PANE, title: 'idle-mod', focus: true, closeOnEscape: true })
          },
        }),
      ],
    })
  })

  // The pane: everything at once, each fixable line with its own button.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    // An empty pane keeps the rescan row below, so a scan can always be rerun.
    const empty = Text({
      children: [collecting ? 'idle-mod: scanning…' : collectedAt ? 'idle-mod: nothing to report.' : 'idle-mod: not scanned yet.'],
      dimColor: true,
    })

    // Each row: the finding on the left, its buttons on the right edge, so the
    // buttons line up in one column. preview shows the exact prompt fix sends.
    const rows = !insights.length ? [empty] : insights.map((item, i) => {
      const line = Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        columnGap: 2,
        children: [
          Box({
            flexDirection: 'row',
            flexShrink: 1,
            columnGap: 1,
            children: [
              Text({ children: ['●'], color: DOT[item.severity] }),
              Text({ children: [item.text], dimColor: item.severity === 'info' }),
            ],
          }),
          ...(item.fix
            ? [
                Box({
                  flexDirection: 'row',
                  columnGap: 1,
                  children: [
                    Button({
                      key: 'preview-' + i,
                      label: previewed === item.text ? 'hide' : 'preview',
                      onPress: async () => {
                        previewed = previewed === item.text ? null : item.text
                        redraw($)
                      },
                    }),
                    Button({
                      key: 'fix-' + i,
                      label: 'fix with Claude',
                      onPress: async () => {
                        previewed = null
                        await $.ui.close({ id: PANE })
                        await $.prompt.submit({ text: item.fix, asUser: true })
                      },
                    }),
                  ],
                }),
              ]
            : []),
        ],
      })
      if (!item.fix || previewed !== item.text) return line
      return Box({
        flexDirection: 'column',
        children: [
          line,
          Box({
            flexDirection: 'column',
            paddingLeft: 2,
            children: [
              Text({ children: ['fix with Claude sends this prompt:'], dimColor: true }),
              Text({ children: [item.fix] }),
            ],
          }),
        ],
      })
    })

    const age = Math.round((Date.now() - collectedAt) / 60000)
    const status = collecting ? 'scanning…' : collectedAt ? `scanned ${age}m ago` : ''

    return Box({
      flexDirection: 'column',
      children: [
        ...rows,
        Text({ children: [' '] }),
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Button({
              key: 'rescan',
              label: 'rescan',
              hotkey: 'r',
              plain: true,
              onPress: async () => {
                await collect($)
              },
            }),
            Text({ children: [status], dimColor: true }),
          ],
        }),
      ],
    })
  })
}
