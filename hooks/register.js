// idle-mod
// Fills Claude Code's wait state with facts about your own project.
// No telemetry, no server, no model calls; only npm talks to its registry.

const PANE = 'idle-mod'
const MAX_AGE_MS = 30 * 60 * 1000
const ROTATE_MS = 12000
const KEEP_PROJECTS = 20

// Severity sets the order in the pane; the band rotates through every line.
const SEV = { high: 0, warn: 1, info: 2 }
const CHECKS = { npm: 'npm checks', git: 'git checks', debt: 'TODO/FIXME count', work: 'session checks' }
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
// The pane's chosen tab: 'all', or one of TABS.
let tab = 'all'
// The lines the person chose to ignore in this project, by idOf, kept in $.store.
let ignored = new Set()

function fresh() {
  return { since: Math.floor(Date.now() / 1000), touched: new Set(), npmBefore: null, depsBefore: new Map(), dirty: { git: false, npm: false } }
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

// Markers as comments write them: right after `//`, `#`, `/*`, `*`, `--`, `;`
// or `<!--`, as `FIXME:` or `FIXME(name)`. git grep -E patterns.
const OPENER = '(//|#|/\\*|\\*|--|;|<!--)[[:space:]]*'
const MARK = { FIXME: OPENER + 'FIXME[:(]', TODO: OPENER + 'TODO[:(]' }
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
const ignoreKey = (w) => 'ignored:' + w.top
const MAX_IGNORED = 200

// What an ignored line is known by. Most lines by their text, so a line whose
// numbers change comes back; a secret by its file and kind, a FIXME by its
// file and comment, so that editing elsewhere in the file keeps them ignored.
const idOf = (item) => item.id || `${item.kind}|${item.text}`
const isIgnored = (item) => ignored.has(idOf(item))

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
  session.depsBefore = new Map()
  ignored = new Set()
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
  try {
    const ids = await $.store.get(ignoreKey(w))
    if (Array.isArray(ids)) ignored = new Set(ids.filter((id) => typeof id === 'string'))
  } catch {
    // nothing ignored yet
  }
}

// Hide a line in this project from now on, across sessions.
async function ignore($, item) {
  ignored.add(idOf(item))
  previewed = null
  redraw($)
  try {
    await $.store.set(ignoreKey(where), [...ignored].slice(-MAX_IGNORED))
  } catch {
    // kept for this session only
  }
}

// Bring every ignored line back. A rescan finds the secrets the last one
// left out for being ignored.
async function unignoreAll($) {
  ignored = new Set()
  try {
    await $.store.delete(ignoreKey(where))
  } catch {
    // nothing stored
  }
  await collect($, { npm: false })
}

async function npmInsights($, w) {
  if (!(await exists($, `${w.npm}/package.json`))) return []

  // A project's .npmrc can point npm at any host and fill its values from
  // environment variables, so a cloned repo could make npm send your tokens
  // there. npm has no switch to ignore it, so such projects are not checked.
  if ((await npmrcInRepo($, w)) || (await exists($, `${w.top}/.npmrc`))) {
    return [{ kind: 'skip', severity: 'info', text: 'npm checks skipped: this project has its own .npmrc' }]
  }

  const [audit, outdated] = await Promise.all([
    run($, ['npm', 'audit', '--json', NPM_SAFE], w.npm, 30000),
    run($, ['npm', 'outdated', '--json', NPM_SAFE], w.npm, 60000),
  ])
  if (failed(audit)) return audit
  if (failed(outdated)) return outdated

  // npm 8 writes the no-lockfile error to stderr and leaves stdout empty.
  if (!audit.stdout.trim() && /\bENOLOCK\b/.test(audit.stderr || '')) return { failed: 'npm audit needs a package-lock.json' }

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
        kind: 'vuln',
        severity: 'high',
        text: `npm audit: ${critical} critical, ${high} high severity`,
        fix: "Run npm audit, explain each high or critical finding and propose a fix for each. Don't change or install anything until I say so.",
      })
    } else if (moderate) {
      out.push({ kind: 'vuln', severity: 'info', text: `npm audit: ${moderate} moderate, nothing critical` })
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
          kind: 'update',
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
      kind: 'unpushed',
      severity: 'warn',
      text: `${n} unpushed commit${n > 1 ? 's' : ''} on this branch`,
      fix: "Show me the unpushed commits on this branch and tell me whether they look ready to push. Don't push anything until I say so.",
    })
  }
  const m = count(mine)
  if (m > 0) {
    out.push({
      scope: 'session',
      kind: 'unpushed',
      severity: 'warn',
      text: `${m} commit${m > 1 ? 's' : ''} made this session, not pushed yet`,
      fix: "Show me the commits made in this session that are not pushed yet and tell me whether they look ready to push. Don't push anything until I say so.",
    })
  }

  const stashes = stash.stdout.trim() ? stash.stdout.trim().split('\n').length : 0
  if (stashes) out.push({ kind: 'stash', severity: 'info', text: `${stashes} stash${stashes > 1 ? 'es' : ''} sitting around` })

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
      kind: 'branch',
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
    run($, [...GIT, 'grep', '-cIE', '-e', MARK.FIXME], w.top, 10000),
    run($, [...GIT, 'grep', '-cIE', '-e', MARK.TODO], w.top, 10000),
    inFiles('-nIzE', MARK.FIXME),
    inFiles('-cIE', MARK.TODO),
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
      kind: 'fixme',
      severity: 'warn',
      text: `${nFixme} FIXME marker${nFixme > 1 ? 's' : ''} in tracked files`,
      fix: 'Find the FIXME markers, group them by theme, and tell me which ones are worth fixing now.',
    })
  }
  if (nTodo) out.push({ kind: 'todo', severity: 'info', text: `${nTodo} TODO marker${nTodo > 1 ? 's' : ''} across the project` })

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
      kind: 'fixme',
      severity: 'warn',
      id: `fixme|${path}|${note}`,
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
      kind: 'fixme',
      severity: 'warn',
      text: `${more} more FIXME marker${more > 1 ? 's' : ''} in files changed this session`,
      fix: 'Find the FIXME markers in the files you changed in this session and tell me which ones to fix now.',
    })
  }
  const sTodo = total(myTodo)
  if (sTodo) {
    out.push({ scope: 'session', kind: 'todo', severity: 'info', text: `${sTodo} TODO marker${sTodo > 1 ? 's' : ''} in files changed this session` })
  }
  return out
}

// ------------------------------------------------- what this session left
// Read from the files Claude changed and from git's objects only: git diff
// and git status would run the repo's own filters and diff drivers on them.

const SOURCE = /\.(c|cc|cpp|cs|cjs|go|h|hpp|java|js|jsx|kt|mjs|php|py|rb|rs|scala|svelte|swift|ts|tsx|vue)$/i
const TEST = /(^|\/)(tests?|__tests__|specs?)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/i
// What a secret looks like, the first match naming it. The value itself is
// never shown, stored or sent: only its kind, file and line.
const SECRETS = [
  ['private key', /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}/],
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI API key', /sk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ['Slack token', /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Stripe live key', /[rs]k_live_[A-Za-z0-9]{20,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
]
const MAX_SECRET_ROWS = 5
// Files compared with the last commit, and how big a file may be to read.
const MAX_DIFF_FILES = 50
const MAX_READ = 1000000

// Lines as git counts them: a final newline ends the last line, it adds none.
const splitLines = (s) => s.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')

// Lines added and removed, counted as a multiset: close to git's numbers for
// an ordinary edit, and cheap.
function churn(before, after) {
  const left = new Map()
  for (const l of before) left.set(l, (left.get(l) || 0) + 1)
  let added = 0
  for (const l of after) {
    const n = left.get(l) || 0
    if (n) left.set(l, n - 1)
    else added++
  }
  let removed = 0
  for (const n of left.values()) removed += n
  return { added, removed }
}

async function readText($, path) {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' && text.length <= MAX_READ && !text.includes('\0') ? text : null
  } catch {
    return null
  }
}

// The secrets a file's text may hold, by line.
function secretsIn(text, file) {
  const out = []
  splitLines(text).forEach((line, i) => {
    const hit = SECRETS.find(([, re]) => re.test(line))
    if (hit) out.push({ file, line: i + 1, label: hit[0], id: `secret|${file}|${hit[0]}` })
  })
  return out
}

// Dependency names as each ecosystem writes them, checked before they reach
// a prompt. Python's are compared in their normalized form (PEP 503).
const PY_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/
const CRATE_NAME = /^[A-Za-z0-9_-]{1,64}$/
const pyName = (s) => {
  const m = /^[ \t]*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(s)
  return m && PY_NAME.test(m[1]) ? m[1].toLowerCase().replace(/[-_.]+/g, '-') : null
}

function npmDeps(text) {
  try {
    const pkg = JSON.parse(text)
    const names = new Set()
    for (const list of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = pkg && pkg[list]
      if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
        for (const name of Object.keys(deps)) if (PKG_NAME.test(name)) names.add(name)
      }
    }
    return names
  } catch {
    return null
  }
}

function requirementsDeps(text) {
  const names = new Set()
  for (const line of splitLines(text)) {
    // Options (-r, -e, --index-url) and comments name no package.
    if (/^[ \t]*(-|#|$)/.test(line)) continue
    const name = pyName(line)
    if (name) names.add(name)
  }
  return names
}

// TOML, as far as dependency lists go: each [table] with its lines.
function tomlTables(text) {
  const tables = [{ name: '', body: [] }]
  for (const raw of splitLines(text)) {
    const line = raw.trim()
    if (line.startsWith('#')) continue
    const head = /^\[\[?([^\]]+)\]\]?$/.exec(line)
    if (head) tables.push({ name: head[1].replace(/\s+/g, ''), body: [] })
    else tables[tables.length - 1].body.push(line)
  }
  return tables.map((t) => ({ name: t.name, body: t.body.join('\n') }))
}

// The strings of the TOML array that opens at s[i], inline tables skipped,
// and where it ends: the end of the text when it never closes.
function tomlArray(s, i) {
  const out = []
  for (i++; i < s.length; i++) {
    const c = s[i]
    if (c === ']') break
    if (c === '{' || c === '"' || c === "'") {
      const j = s.indexOf(c === '{' ? '}' : c, i + 1)
      if (j < 0) return { strings: out, end: s.length }
      if (c !== '{') out.push(s.slice(i + 1, j))
      i = j
    }
  }
  return { strings: out, end: i }
}

// Each `key = [ ... ]` of a table body, as [key, strings]. The lines are
// trimmed, and the patterns never cross one: a repo's file of blank lines
// would otherwise cost them quadratic time.
function tomlArrays(body) {
  const out = []
  const re = /(^|\n)["']?([A-Za-z0-9_.-]+)["']?[ \t]*=[ \t]*\[/g
  let m
  while ((m = re.exec(body))) {
    // The next key is looked for past this array, so each character is read once.
    const { strings, end } = tomlArray(body, re.lastIndex - 1)
    out.push([m[2], strings])
    re.lastIndex = end
  }
  return out
}

// The keys of a table body: `name = ...`.
const tomlKeys = (body) => [...body.matchAll(/(^|\n)["']?([A-Za-z0-9_.-]+)["']?[ \t]*=/g)].map((m) => m[2])

// PEP 621 lists, PEP 735 groups and Poetry's tables.
function pyprojectDeps(text) {
  const names = new Set()
  const add = (n) => n && names.add(n)
  for (const { name, body } of tomlTables(text)) {
    if (name === 'project') {
      for (const [key, list] of tomlArrays(body)) if (key === 'dependencies') list.forEach((s) => add(pyName(s)))
    } else if (name === 'project.optional-dependencies' || name === 'dependency-groups') {
      for (const [, list] of tomlArrays(body)) list.forEach((s) => add(pyName(s)))
    } else if (/^tool\.poetry\.(group\.[^.]+\.)?(dev-)?dependencies$/.test(name)) {
      for (const key of tomlKeys(body)) if (key !== 'python') add(pyName(key))
    }
  }
  return names
}

// [dependencies], [dev-dependencies], [build-dependencies], with their
// target and workspace forms, and the [dependencies.name] form.
function cargoDeps(text) {
  const names = new Set()
  for (const { name, body } of tomlTables(text)) {
    const one = /(^|\.)(dev-|build-)?dependencies\.([^.]+)$/.exec(name)
    if (one) {
      if (CRATE_NAME.test(one[3])) names.add(one[3])
    } else if (/(^|\.)(dev-|build-)?dependencies$/.test(name)) {
      for (const key of tomlKeys(body)) if (CRATE_NAME.test(key)) names.add(key)
    }
  }
  return names
}

const MANIFESTS = [
  ['package.json', npmDeps],
  ['requirements.txt', requirementsDeps],
  ['pyproject.toml', pyprojectDeps],
  ['Cargo.toml', cargoDeps],
]

// The dependencies in the project's manifests that were not there at the
// session's first scan. A manifest missing then counts as empty, so one
// created this session brings all its names; one that can't be read or
// parsed is left out until it can.
async function addedDeps($, w) {
  const added = new Set()
  for (const [file, parse] of MANIFESTS) {
    const path = `${w.npm}/${file}`
    const text = await readText($, path)
    const names = text !== null ? parse(text) : (await exists($, path)) ? null : new Set()
    if (!names) continue
    if (!session.depsBefore.has(file)) session.depsBefore.set(file, names)
    const before = session.depsBefore.get(file)
    for (const name of names) if (!before.has(name)) added.add(name)
  }
  return [...added]
}

async function workInsights($, w) {
  const out = []
  const files = touchedIn(w)

  // Dependencies added since the session's first scan, by Claude's edits or
  // by an install, in package.json, requirements.txt, pyproject.toml or
  // Cargo.toml. Names pass their ecosystem's format before reaching a prompt.
  const added = await addedDeps($, w)
  if (added.length) {
    const names = added.slice(0, 3).join(', ') + (added.length > 3 ? ` (+${added.length - 3} more)` : '')
    out.push({
      scope: 'session',
      kind: 'dep',
      severity: 'warn',
      text: `${added.length} dependenc${added.length > 1 ? 'ies' : 'y'} added this session: ${names}`,
      fix: `Review the dependencies added in this session (${names}): what each one is for, whether it is maintained, and whether we need it. Don't install or remove anything until I say so.`,
    })
  }

  // Code changed with no test changed alongside it.
  const sources = files.filter((f) => SOURCE.test(f) && !TEST.test(f))
  if (sources.length && !files.some((f) => TEST.test(f))) {
    out.push({
      scope: 'session',
      kind: 'tests',
      severity: 'warn',
      text: `${sources.length} source file${sources.length > 1 ? 's' : ''} changed this session, no test changed`,
      fix: "Look at the code you changed in this session and tell me which tests are missing or should change. Don't write any until I say so.",
    })
  }

  // Each changed file against the last commit, and the secrets it may hold.
  const git = await exists($, `${w.top}/.git`)
  let changed = 0
  let plus = 0
  let minus = 0
  const secrets = []
  for (const file of files.slice(0, MAX_DIFF_FILES)) {
    const now = await readText($, `${w.top}/${file}`)
    if (now !== null) secrets.push(...secretsIn(now, file))
    if (!git) continue
    const blob = await run($, [...GIT, 'cat-file', 'blob', `HEAD:${file}`], w.top, 8000)
    if (failed(blob)) return blob
    const before = blob.exitCode === 0 && !blob.isStdoutTruncated ? blob.stdout : null
    if (before === null && now === null) continue
    const a = before === null ? [] : splitLines(before)
    const b = now === null ? [] : splitLines(now)
    if (before !== null && now !== null && a.join('\n') === b.join('\n')) continue
    const c = churn(a, b)
    changed++
    plus += c.added
    minus += c.removed
  }
  if (changed) {
    out.push({
      scope: 'session',
      kind: 'uncommitted',
      severity: 'warn',
      text: `${changed} file${changed > 1 ? 's' : ''} changed this session, not committed (+${plus} −${minus})`,
      fix: "Show me what you changed in this session that is not committed yet, summarize it, and propose how to split it into commits. Don't commit anything until I say so.",
    })
  }

  const anySecret = "Look for secrets in the files you changed in this session and tell me how to move them out of the code. Don't print any value, and don't commit or push anything until I say so."
  // An ignored secret leaves room for the next one.
  const live = secrets.filter((hit) => !ignored.has(hit.id))
  for (const hit of live.slice(0, MAX_SECRET_ROWS)) {
    out.push({
      scope: 'session',
      kind: 'secret',
      severity: 'high',
      id: hit.id,
      text: `possible ${hit.label} in ${safe(hit.file, 60)}:${hit.line}`,
      fix: PLAIN_PATH.test(hit.file)
        ? `Look at ${hit.file}:${hit.line}: it may hold a ${hit.label}. Tell me whether it is a real secret and how to move it out of the code. Don't print the value, and don't commit or push anything until I say so.`
        : anySecret,
    })
  }
  const more = live.length - MAX_SECRET_ROWS
  if (more > 0) {
    out.push({
      scope: 'session',
      kind: 'secret',
      severity: 'high',
      text: `${more} more possible secret${more > 1 ? 's' : ''} in files changed this session`,
      fix: anySecret,
    })
  }
  return out
}

// The secrets, not ignored, in the files Claude changed this session, read
// from disk now rather than from the last scan.
async function secretsNow($) {
  const w = where
  if (!w.top) return []
  const hits = []
  for (const file of touchedIn(w).slice(0, MAX_DIFF_FILES)) {
    const text = await readText($, `${w.top}/${file}`)
    if (text !== null) hits.push(...secretsIn(text, file).filter((hit) => !ignored.has(hit.id)))
  }
  return hits
}

// A Bash command that makes a commit: `git commit`, with or without options
// between, also after `&&` or `;`. One search per part, so a long command
// costs linear time.
const isCommit = (command) =>
  command.split(/[\n;&|]/).some((part) => {
    const at = part.search(/\bgit\b/)
    return at >= 0 && /\scommit\b/.test(part.slice(at))
  })

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
    const sources = ['npm', 'git', 'debt', 'work']
    const groups = await Promise.all([npm ? npmInsights($, w) : null, gitInsights($, w), debtInsights($, w), workInsights($, w)])
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
// One glyph per kind of finding, one column wide, colored by severity.
// A line saved by an older version has no kind and keeps the dot.
const ICON = { vuln: '⚠', update: '⇡', unpushed: '↑', stash: '≡', branch: '⎇', fixme: '✱', todo: '○', skip: '⊘', uncommitted: '±', dep: '⊕', tests: '∅', secret: '⚑' }
// U+FE0E asks for the glyph as text: a desktop would otherwise draw some glyphs as
// a colored emoji, deaf to the severity color.
const icon = (item) => (ICON[item.kind] || '●') + '︎'
// The pane's tabs: every line belongs to one kind of work, in this order.
const TABS = [
  ['security', 'Security'],
  ['changes', 'Changes'],
  ['code', 'Code'],
]
const CATEGORY = {
  secret: 'security',
  vuln: 'security',
  skip: 'security',
  uncommitted: 'changes',
  unpushed: 'changes',
  dep: 'changes',
  update: 'changes',
  stash: 'changes',
  branch: 'changes',
  fixme: 'code',
  todo: 'code',
  tests: 'code',
}
// A line saved by an older version has no kind: its check decides.
const category = (item) => CATEGORY[item.kind] || (item.source === 'debt' ? 'code' : 'changes')

const mine = () => insights.filter((item) => item.scope === 'session' && !isIgnored(item))

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

  // Claude's commits wait while a file it changed this session may hold a
  // secret. The reason names the file, line and kind, never the value; an
  // ignored secret lets the commit through. Where nothing draws there is no
  // pane to ignore it from, so headless runs commit as they would.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!interactive || !isCommit(String(e.command || ''))) return next(e)
    const hits = await secretsNow($)
    if (!hits.length) return next(e)
    const places = hits
      .slice(0, 3)
      // The reason reaches the model: an odd file name stays out of it.
      .map((hit) => (PLAIN_PATH.test(hit.file) ? `${hit.file}:${hit.line} (${hit.label})` : `a file changed this session (${hit.label})`))
      .join(', ')
    const rest = hits.length > 3 ? ` and ${hits.length - 3} more` : ''
    return {
      deny:
        `idle-mod stopped this commit: ${places}${rest} may hold a secret. ` +
        "Don't print the value. Tell the person which line it is and propose how to move it out of the code. " +
        "If it is not a real secret, they can press Ignore on its line in the idle-mod pane; then commit again. Don't try to commit another way.",
    }
  }).catch(passOn)

  // Commands that change commits or installed packages call for a rescan.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    try {
      const command = String(e.command || '')
      if (/\bgit\s+(commit|merge|rebase|cherry-pick|revert|am|pull|reset|push)\b/.test(command)) session.dirty.git = true
      if (/\b(npm|pnpm|yarn)\s+(i|install|add|ci|update|up|upgrade|remove|rm|uninstall)\b/.test(command)) session.dirty.npm = true
      // These write the manifests the session checks read.
      if (/\b(uv|poetry|cargo)\s+(add|remove|rm)\b/.test(command)) session.dirty.git = true
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
        Text({ children: [icon(item)], color: DOT[item.severity] }),
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
    const clear = collectedAt && !collecting && !problems.length
    const empty = Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [
        ...(clear ? [Text({ children: ['✓'], color: 'green' })] : []),
        Text({ children: [collecting ? 'scanning…' : collectedAt ? done : 'not scanned yet.'], dimColor: true }),
      ],
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
        flexWrap: 'nowrap',
        columnGap: 2,
        children: [
          // A long finding wraps within its own column; the buttons never move.
          Box({
            flexDirection: 'row',
            flexShrink: 1,
            minWidth: 0,
            flexWrap: 'nowrap',
            columnGap: 1,
            children: [
              // The glyph keeps its place beside the text, which wraps alone.
              Box({ flexShrink: 0, children: [Text({ children: [icon(item)], color: DOT[item.severity] })] }),
              Box({ flexShrink: 1, minWidth: 0, children: [Text({ children: [item.text], dimColor: item.severity === 'info' })] }),
            ],
          }),
          Box({
            flexDirection: 'row',
            flexShrink: 0,
            columnGap: 1,
            children: [
              // preview is the eye; fix is the button to press.
              ...(item.fix
                ? [
                    Button({
                      key: 'preview-' + i,
                      label: previewed === item.text ? '✕' : '👁',
                      onPress: async () => {
                        previewed = previewed === item.text ? null : item.text
                        redraw($)
                      },
                    }),
                    Button({
                      key: 'fix-' + i,
                      label: 'Fix with Claude',
                      variant: 'primary',
                      onPress: async () => {
                        previewed = null
                        await $.ui.close({ id: PANE })
                        await $.prompt.submit({ text: item.fix, asUser: true })
                      },
                    }),
                  ]
                : []),
              Button({
                key: 'ignore-' + i,
                label: 'Ignore',
                onPress: async () => {
                  await ignore($, item)
                },
              }),
            ],
          }),
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
              Text({ children: ['Fix with Claude sends this prompt:'], dimColor: true }),
              Text({ children: [item.fix] }),
            ],
          }),
        ],
      })
    }

    // This session's lines first; the project's, there before the session
    // started or outside what it changed, folded below until asked for.
    // The chosen tab filters both sections; All shows each by kind of work.
    const shown = (item) => tab === 'all' || category(item) === tab
    const ours = mine().filter(shown)
    const theirs = insights.filter((item) => item.scope !== 'session' && !isIgnored(item) && shown(item))
    const hidden = ignored.size
    const heading = (text) => Text({ children: [text], bold: true })
    const count = (n) => (n ? ` · ${n}` : '')
    const grouped = (items) =>
      tab !== 'all'
        ? items.map(row)
        : TABS.flatMap(([key, title]) => {
            const lines = items.filter((item) => category(item) === key)
            return lines.length ? [Text({ children: [title.toUpperCase()], dimColor: true, bold: true }), ...lines.map(row)] : []
          })

    // One tab per kind of work, each with how many lines this session holds.
    const all = mine()
    const tabs = Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 1,
      children: [['all', 'All'], ...TABS].map(([key, title]) => {
        const n = key === 'all' ? all.length : all.filter((item) => category(item) === key).length
        return Button({
          key: 'tab-' + key,
          label: n ? `${title} ${n}` : title,
          ...(tab === key ? { variant: 'primary' } : {}),
          onPress: async () => {
            tab = key
            redraw($)
          },
        })
      }),
    })
    const quiet =
      tab === 'all'
        ? empty
        : Text({ children: [`nothing under ${TABS.find(([key]) => key === tab)[1]} in this session.`], dimColor: true })

    const project = theirs.length
      ? [
          Text({ children: [' '] }),
          Button({
            key: 'project',
            label: `${projectOpen ? '▾' : '▸'} In the project${count(theirs.length)}`,
            onPress: async () => {
              projectOpen = !projectOpen
              redraw($)
            },
          }),
          ...(projectOpen ? [Box({ flexDirection: 'column', paddingLeft: 2, children: grouped(theirs) })] : []),
        ]
      : []

    const age = Math.round((Date.now() - collectedAt) / 60000)
    const status = collecting ? 'scanning…' : collectedAt ? `scanned ${age}m ago` : ''

    return Box({
      flexDirection: 'column',
      children: [
        tabs,
        Text({ children: [' '] }),
        heading('This session' + count(ours.length)),
        ...(ours.length ? grouped(ours) : [quiet]),
        ...notes,
        ...project,
        Text({ children: [' '] }),
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Button({
              key: 'rescan',
              label: '↻ rescan',
              hotkey: 'r',
              plain: true,
              onPress: async () => {
                await collect($)
              },
            }),
            Text({ children: [status], dimColor: true }),
            ...(hidden
              ? [
                  Button({
                    key: 'unignore',
                    label: `${hidden} ignored · show again`,
                    plain: true,
                    onPress: async () => {
                      await unignoreAll($)
                    },
                  }),
                ]
              : []),
          ],
        }),
      ],
    })
  })
}
