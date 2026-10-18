// idle-mod
// Fills Claude Code's wait state with facts about your own project.
// No telemetry, no server, no model calls; only npm talks to its registry.

const PANE = 'idle-mod'
const MAX_AGE_MS = 30 * 60 * 1000
const ROTATE_MS = 12000
const KEEP_PROJECTS = 20

// Severity sets the order in the pane; the band rotates through every line.
const SEV = { high: 0, warn: 1, info: 2 }
const CHECKS = { npm: 'npm checks', git: 'git checks', debt: 'TODO/FIXME count' }
// What to do when a command the checks need cannot start.
const HELP = {
  git: { install: 'Install Git, then restart Claude Code.', href: 'https://git-scm.com/downloads', label: 'git-scm.com/downloads' },
  npm: { install: 'Install Node.js, which includes npm, then restart Claude Code.', href: 'https://nodejs.org/en/download', label: 'nodejs.org/en/download' },
}

// Module state. Lost on reload, rebuilt by the next session.start.
let insights = []
let collectedAt = 0
let collecting = false
let busy = false
let interactive = true
// The finding whose prompt the pane shows in full, by its text; null for none.
let previewed = null
// Why checks of the last scan could not run, one line each, for the pane.
let problems = []
// The project the findings belong to: `top` runs git, `npm` runs the npm checks.
let where = { top: '', npm: '', git: false }
// This session: when it started (unix seconds), the files Claude changed in
// it, the npm lines already there at its first scan, and what its tools did
// since the last scan. A line that is not this session's is the project's.
let session = fresh()
// Whether the pane shows the project's lines below this session's.
let projectOpen = false

function fresh() {
  return { since: Math.floor(Date.now() / 1000), touched: new Set(), npmBefore: null, dirty: { git: false, npm: false } }
}

// A cloned repo's .git/config names programs for git to run. These overrides
// keep the checks from running one: core.fsmonitor (run by git grep) and
// gpg.program (run by git log and friends when log.showSignature is on).
// submodule.recurse keeps git out of submodules the repo brings along.
const GIT = ['git', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'submodule.recurse=false']
const NPM_SAFE = '--git=git'

// Names and versions come from the project's own files and end up in a prompt
// sent as the user, so they are used only when they look like what npm writes.
const PKG_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,213}$/
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]{1,20})?(\+[0-9A-Za-z.]{1,20})?$/

// Text from the repo that is shown but never sent: printable ASCII only.
const safe = (s, max = 40) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, max)

// Markers as comments write them: `FIXME:` or `FIXME(name)`, a git grep pattern.
const MARK = { FIXME: 'FIXME[:(]', TODO: 'TODO[:(]' }
// This session's FIXMEs get a line each, up to this many.
const MAX_MARK_ROWS = 10
// A file name that may go into a prompt: letters, digits and . _ - / only.
const PLAIN_PATH = /^[A-Za-z0-9._\/-]{1,200}$/

// --------------------------------------------------------------- collectors
// Each collector returns a list of { severity, text, fix }, or { failed } with
// the reason when a check could not run: the previous lines of that collector
// then stay, and the pane says why. None of them throws.

// $.process.run rejects both when a command cannot start and when it runs out
// of time; how long it took tells the two apart.
async function run($, argv, cwd, timeoutMs) {
  const started = Date.now()
  try {
    return await $.process.run(argv, { cwd, timeoutMs })
  } catch {
    const late = Date.now() - started >= timeoutMs - 1000
    if (late) return { failed: `${argv[0]} timed out` }
    return { failed: `${argv[0]} could not start`, missing: argv[0] }
  }
}

const failed = (r) => Boolean(r && r.failed)

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
  const git = Boolean(r && r.exitCode === 0 && r.stdout.trim())
  const top = git ? r.stdout.trim() : root
  const npm = (await exists($, `${root}/package.json`)) ? root : top
  return { top, npm, git }
}

// npm 10 run in a workspace package also reads the .npmrc of the workspace
// root above it, so every folder from the npm one up to the repo's top is
// checked: those are the folders a cloned repo controls. Above the top the
// .npmrc files are the person's own, and outside git only the npm folder is.
async function npmrcInRepo($, w) {
  let dir = w.npm
  for (let depth = 0; depth < 40; depth++) {
    if (await exists($, `${dir}/.npmrc`)) return true
    if (!w.git || (await exists($, `${dir}/.git`))) return false
    const up = dir.replace(/[\\/]+[^\\/]*$/, '')
    if (!up || up === dir) return false
    dir = up
  }
  return true
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
  problems = []
  collectedAt = 0
  // Another project's npm lines say nothing about what this one had.
  session.npmBefore = null
  try {
    const saved = await $.store.get(scanKey(w))
    if (saved && Array.isArray(saved.insights)) {
      // A saved session line belonged to the session that saved it.
      insights = saved.insights.filter((item) => item.scope !== 'session')
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
  if ((await npmrcInRepo($, w)) || (await exists($, `${w.top}/.npmrc`))) {
    return [{ severity: 'info', text: 'npm checks skipped: this project has its own .npmrc' }]
  }

  const [audit, outdated] = await Promise.all([
    run($, ['npm', 'audit', '--json', NPM_SAFE], w.npm, 30000),
    run($, ['npm', 'outdated', '--json', NPM_SAFE], w.npm, 60000),
  ])
  if (failed(audit)) return audit
  if (failed(outdated)) return outdated

  const out = []
  try {
    const report = JSON.parse(audit.stdout)
    if (report.error && report.error.code === 'ENOLOCK') return { failed: 'npm audit needs a package-lock.json' }
    const vulns = report.metadata.vulnerabilities
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
    return { failed: 'npm audit gave no report' }
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
      return { failed: 'npm outdated gave no report' }
    }
  }
  return out
}

async function gitInsights($, w) {
  if (!(await exists($, `${w.top}/.git`))) return []

  const [ahead, mine, stash, branches] = await Promise.all([
    run($, [...GIT, 'rev-list', '--count', '@{u}..HEAD'], w.top, 8000),
    run($, [...GIT, 'rev-list', '--count', `--since=@${session.since}`, '@{u}..HEAD'], w.top, 8000),
    run($, [...GIT, 'stash', 'list'], w.top, 8000),
    run(
      $,
      [...GIT, 'for-each-ref', '--sort=committerdate', '--format=%(HEAD)|%(committerdate:unix)|%(refname:short)', 'refs/heads/'],
      w.top,
      8000,
    ),
  ])
  const broken = [ahead, mine, stash, branches].find(failed)
  if (broken) return broken

  const out = []
  // No upstream, a detached HEAD or no commits yet: rev-list fails, no line.
  const count = (r) => (r.exitCode === 0 ? Number(r.stdout.trim()) || 0 : 0)
  const n = count(ahead)
  if (n > 0) {
    out.push({
      severity: 'warn',
      text: `${n} unpushed commit${n > 1 ? 's' : ''} on this branch`,
      fix: "Show me the unpushed commits on this branch and tell me whether they look ready to push. Don't push anything until I say so.",
    })
  }
  const m = count(mine)
  if (m > 0) {
    out.push({
      scope: 'session',
      severity: 'warn',
      text: `${m} commit${m > 1 ? 's' : ''} made this session, not pushed yet`,
      fix: "Show me the commits made in this session that are not pushed yet and tell me whether they look ready to push. Don't push anything until I say so.",
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
  // never enter the count. It counts lines that hold the marker as a comment
  // writes it, `FIXME:` or `FIXME(`, not the bare word in a sentence. The
  // files changed this session are searched again on their own, new ones
  // included, their names taken literally rather than as patterns.
  const files = touchedIn(w)
  const inFiles = (flags, word) =>
    files.length
      ? run($, [...GIT, '--literal-pathspecs', 'grep', flags, '--untracked', '-e', word, '--', ...files], w.top, 10000)
      : { exitCode: 1, stdout: '' }
  const [fixme, todo, myFixme, myTodo] = await Promise.all([
    run($, [...GIT, 'grep', '-cI', '-e', MARK.FIXME], w.top, 10000),
    run($, [...GIT, 'grep', '-cI', '-e', MARK.TODO], w.top, 10000),
    inFiles('-nIz', MARK.FIXME),
    inFiles('-cI', MARK.TODO),
  ])
  const broken = [fixme, todo, myFixme, myTodo].find(failed)
  if (broken) return broken

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

  // One line per FIXME of this session, with its own button. Its comment is
  // the repo's text: shown cleaned, never put in the prompt, which names only
  // the file and line, so Claude reads the comment as code rather than orders.
  // A file name may hold a newline and so forge a row: only rows that name
  // one of the files asked about count.
  const asked = new Set(files)
  const marks = myFixme.stdout
    .split('\n')
    .map((l) => l.split('\0'))
    .filter((p) => p.length >= 3 && asked.has(p[0]) && /^\d+$/.test(p[1]))
  for (const [path, line, ...rest] of marks.slice(0, MAX_MARK_ROWS)) {
    const note = rest.join(' ').replace(/^.*?FIXME(\([^)]*\))?:?\s*/, '')
    out.push({
      scope: 'session',
      severity: 'warn',
      text: `FIXME ${safe(path, 60)}:${line} ${safe(note, 60)}`.trim(),
      fix: PLAIN_PATH.test(path)
        ? `Look at the FIXME at ${path}:${line}, tell me what it is about and propose a fix. Don't change anything until I say so.`
        : 'Find the FIXME markers in the files you changed in this session and tell me which ones to fix now.',
    })
  }
  const more = marks.length - MAX_MARK_ROWS
  if (more > 0) {
    out.push({
      scope: 'session',
      severity: 'warn',
      text: `${more} more FIXME marker${more > 1 ? 's' : ''} in files changed this session`,
      fix: 'Find the FIXME markers in the files you changed in this session and tell me which ones to fix now.',
    })
  }
  const sTodo = total(myTodo)
  if (sTodo) {
    out.push({ scope: 'session', severity: 'info', text: `${sTodo} TODO marker${sTodo > 1 ? 's' : ''} in files changed this session` })
  }
  return out
}

// The files changed this session inside this repo, relative to its top.
function touchedIn(w) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  const top = norm(w.top) + '/'
  const out = []
  for (const path of session.touched) {
    const f = norm(path)
    if (f.toLowerCase().startsWith(top.toLowerCase()) && f.length > top.length) out.push(f.slice(top.length))
  }
  return out.slice(0, 200)
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

// Never rejects, so callers may leave it unawaited. `npm: false` keeps the
// npm lines as they are: a quick rescan after a turn, with no network.
async function collect($, { npm = true } = {}) {
  if (collecting || !interactive) return
  collecting = true
  session.dirty = { git: false, npm: npm ? false : session.dirty.npm }
  let w = null
  try {
    await follow($)
    w = where
    if (!w.top) return
    const sources = ['npm', 'git', 'debt']
    const groups = await Promise.all([npm ? npmInsights($, w) : null, gitInsights($, w), debtInsights($, w)])
    if (w !== where) return
    // The npm lines there at the session's first scan are the project's;
    // one that shows up later (after an install, say) is the session's.
    const npmLines = groups[0]
    if (Array.isArray(npmLines)) {
      if (!session.npmBefore) session.npmBefore = new Set(npmLines.map((item) => item.text))
      for (const item of npmLines) if (!session.npmBefore.has(item.text)) item.scope = 'session'
    }
    const kept = (g) => g === null || failed(g)
    insights = groups
      .flatMap((g, i) =>
        kept(g)
          ? insights.filter((item) => item.source === sources[i])
          : g.map((item) => ({ scope: 'project', ...item, source: sources[i] })),
      )
      .sort((a, b) => SEV[a.severity] - SEV[b.severity])
    problems = [
      ...(npm ? [] : problems.filter((p) => p.source === 'npm')),
      ...groups.flatMap((g, i) => (failed(g) ? [{ source: sources[i], text: `${CHECKS[sources[i]]} didn't run: ${g.failed}`, missing: g.missing }] : [])),
    ]
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

const mine = () => insights.filter((item) => item.scope === 'session')

// The band rotates through this session's lines only.
function current() {
  const lines = mine()
  if (!lines.length) return null
  return lines[Math.floor(Date.now() / ROTATE_MS) % lines.length]
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

// The .catch of the hooks that only watch tool calls: the call goes on as is.
function passOn($, e, next) {
  return next(e)
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
    session = fresh()

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

  // After a turn that changed files, made commits or installed packages,
  // rescan: git at once, npm only when the turn touched packages.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    busy = false
    if (interactive && (session.dirty.git || session.dirty.npm)) collect($, { npm: session.dirty.npm })
    redraw($)
    return next(e)
  })

  // The files Claude changes, in the main loop or a subagent, are this
  // session's. A failed or refused edit changed nothing. These hooks only
  // watch: the bookkeeping cannot throw, and if anything else does, the
  // tool call goes on untouched.
  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    on('tool.call', { tool }, async ($, e, next) => {
      const result = await next(e)
      try {
        const path = e.file_path || e.notebook_path
        if (typeof path === 'string' && path && !result.deny && !result.isError) {
          session.touched.add(path)
          session.dirty.git = true
          if (/(^|[\\/])package(-lock)?\.json$/.test(path)) session.dirty.npm = true
        }
      } catch {
        // bookkeeping only
      }
      return result
    }).catch(passOn)
  }

  // Commands that change commits or installed packages call for a rescan.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    try {
      const command = String(e.command || '')
      if (/\bgit\s+(commit|merge|rebase|cherry-pick|revert|am|pull|reset|push)\b/.test(command)) session.dirty.git = true
      if (/\b(npm|pnpm|yarn)\s+(i|install|add|ci|update|up|upgrade|remove|rm|uninstall)\b/.test(command)) session.dirty.npm = true
    } catch {
      // bookkeeping only
    }
    return result
  }).catch(passOn)

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
    // The pane is being drawn, so something draws, whatever session.start said.
    if (!interactive) wake($)
    const { Box, Text, Button, Link } = $.ui.resolve(e)

    // An empty pane keeps the rescan row below, so a scan can always be rerun.
    const done = problems.length ? 'nothing new from the checks that ran.' : 'nothing new in this session.'
    const empty = Text({
      children: [collecting ? 'scanning…' : collectedAt ? done : 'not scanned yet.'],
      dimColor: true,
    })

    // Checks that could not run say so, instead of leaving the pane silent,
    // and a missing command comes with where to get it, once per command.
    const missing = [...new Set(problems.map((p) => p.missing).filter((m) => HELP[m]))]
    const notes = [
      ...problems.map((p) => Text({ children: ['▲ ' + p.text], color: 'yellow' })),
      ...missing.map((m) =>
        Box({
          flexDirection: 'column',
          paddingLeft: 2,
          children: [
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [Text({ children: [HELP[m].install] }), Link({ href: HELP[m].href, label: HELP[m].label })],
            }),
            Text({ children: [`Already installed? If \`${m} --version\` works in a new terminal, restart the app so it sees the same PATH.`], dimColor: true }),
          ],
        }),
      ),
    ]

    // Each row: the finding on the left, its buttons on the right edge, so the
    // buttons line up in one column. preview shows the exact prompt fix sends.
    // A row's keys use its place in `insights`, unique across both sections.
    const row = (item) => {
      const i = insights.indexOf(item)
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
    }

    // This session's lines first; the project's, there before the session
    // started or outside what it changed, folded below until asked for.
    const ours = mine()
    const theirs = insights.filter((item) => item.scope !== 'session')
    const heading = (text) => Text({ children: [text], bold: true })
    const project = theirs.length
      ? [
          Text({ children: [' '] }),
          Button({
            key: 'project',
            label: projectOpen ? 'hide the project lines' : `show the project lines (${theirs.length})`,
            onPress: async () => {
              projectOpen = !projectOpen
              redraw($)
            },
          }),
          ...(projectOpen ? [heading('In the project'), ...theirs.map(row)] : []),
        ]
      : []

    const age = Math.round((Date.now() - collectedAt) / 60000)
    const status = collecting ? 'scanning…' : collectedAt ? `scanned ${age}m ago` : ''

    return Box({
      flexDirection: 'column',
      children: [
        heading('This session'),
        ...(ours.length ? ours.map(row) : [empty]),
        ...notes,
        ...project,
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
