# idle-mod

**The wait state belongs to whoever is waiting.** This is idle-intel rebuilt as a Claude Code mod: while the agent thinks, a line above the prompt tells you something true about the work of this session, and the pane behind it hands each finding to Claude with one button.

```
✻ Incubating… (23s)
◈ FIXME src/app.js:3 race condition on writes          details
```

Click `details`, or run `/idle-mod`, and the pane opens. From the keyboard, `ctrl+x tab` moves focus to the band, then `i` opens it; while you are typing in the prompt, `i` is just a letter.

```
[ All 3 ]  Security   Changes 1   Code 2

This session · 3
  CHANGES
  ↑ 1 commit made this session, not pushed yet      [ 👁 ] [ Fix with Claude ] [ Ignore ]
  CODE
  ✱ FIXME src/app.js:3 race condition on writes      [ 👁 ] [ Fix with Claude ] [ Ignore ]
  ○ 2 TODO markers in files changed this session                        [ Ignore ]

[ ▸ In the project · 5 ]

↻ rescan   scanned 4m ago   1 ignored · show again
```

The tabs along the top sort the work three ways: **Security** (possible secrets, npm vulnerabilities), **Changes** (what is not committed or not pushed, new dependencies, major updates, stashes, stale branches) and **Code** (FIXME, TODO, code changed with no test). A tab shows only its kind of line, in this session and in the project alike; **All** shows everything, grouped the same way.

Open **In the project** for what was there before the session. Each kind of finding has its glyph, colored by how much it matters: ⚠ vulnerabilities, ⇡ major updates, ↑ unpushed commits, ≡ stashes, ⎇ stale branches, ✱ FIXME, ○ TODO, ± changes not committed, ⊕ new dependencies, ∅ code without a test change, ⚑ possible secrets. With nothing new, the session reads `✓ nothing new in this session.`

**This session** lists only what the session itself brought: each FIXME in the files Claude edited or wrote here (new files included) on a line of its own, with file and line and a button for that one, the TODO count of those files, commits made here and not pushed yet, and npm findings that were not there at the session's first scan (after an install, say). The band above the prompt rotates through these lines only. Everything that was already in the project, such as old stashes, stale branches, the project-wide TODO count or a vulnerability that predates the session, sits under **In the project**, folded until you open it. Two sessions on the same project each see their own work.

After a turn that edited files or ran a command, the session lines are rescanned right away (git only, no network); after `npm install` and the like, npm runs again too. A file counts as this session's when Claude's edit tools changed it, or when it was modified after the session began, whatever wrote it: a Bash or PowerShell command, a script, a generator, or your own editor. git lists the files (`git ls-files`, which runs none of the repo's filters); symbolic links are never followed.

👁 shows, under the line, the exact prompt that button would send; **Fix with Claude** closes the pane and submits it for you. The prompts ask Claude to look and propose; none of them tells it to install, push or change anything before you say so.

**Ignore** hides a line in this project, in this session and the next ones. Most lines are known by their text, so one whose numbers change (a third unpushed commit, a new dependency) comes back. A possible secret is known by its file and kind, and a FIXME by its file and comment, so an edit elsewhere in the file keeps them hidden. `N ignored · show again`, next to rescan, brings them all back.

**Commits wait for secrets.** When Claude runs `git commit`, in Bash or PowerShell, while a file changed this session may hold a secret, the mod stops that command and tells Claude the file, line and kind (never the value), and to propose how to move it out of the code. A command that writes a file and commits it in one go (`printf … > x && git commit`) gives the mod nothing to see beforehand, so it reads the commit that command made: if that may hold a secret, Claude is told at once not to push, and to propose taking it out of the commit. A fake key in a test fixture? Press **Ignore** on its line and the next commit goes through. Only Claude's own commits are stopped, subagents' included: one you type in a terminal is yours. It is a guardrail, not a sandbox: it reads the commands Claude runs, and a commit made by a script Claude writes and then runs gets past it. Where nothing is drawn there is no pane to ignore a line from, so headless runs commit as usual, unless you turn on the `headless` option (below).

## Running several agents

When Claude hands work to subagents, or you run several sessions on one project, idle-mod keeps up with them:

- **Subagents count as the session.** The files they change land under **This session**, and their `git commit` waits for secrets like the main agent's.
- **Each session sees the others.** Every session on a project shares its own lines (never a secret's value, never a comment's text), and the pane lists the other sessions' lines under **Other sessions**, folded, each with its session's short id and how long ago it scanned. A session that has not scanned in a day drops out. Several sessions writing the store at the same moment may leave one a scan behind; its next scan catches up.
- **Agents can ask.** The mod gives Claude a tool, `mcp__idle-mod__findings`, that runs the checks again (git and files, no network) and answers with this session's lines, the project's and the other sessions'. An orchestrating agent can call it before it commits, merges or hands work back, or you can tell Claude to. It works where nothing is drawn too. Its answer leaves out the repo's own text, as the prompts do, and tells the model to read the lines as data.
- **The `headless` option** (off by default) makes the mod work where nothing is drawn (`claude -p`, the SDK, CI): Claude's commits wait for secrets there too, and the session scans after each turn and shares its lines with the others. npm never runs there, so nothing leaves the machine. Turn it on in `/config` under idle-mod, or in `settings.json`:

  ```json
  { "pluginConfigs": { "idle-mod": { "options": { "headless": true } } } }
  ```

  A secret that is not real is ignored from the pane of any interactive session on the same project: the ignored lines are shared by every session there.

## What it detects

| Collector | Findings |
|---|---|
| npm | known vulnerabilities (`npm audit`), major version jumps (`npm outdated`) |
| git | unpushed commits, forgotten stashes, branches untouched 30+ days |
| codebase | TODO / FIXME counts, via `git grep` over tracked files only: lines where `FIXME:` or `FIXME(` comes right after a comment opener (`//`, `#`, `/*`, `*`, `--`, `;`, `<!--`), not the word in a sentence or in code that talks about it |
| this session | what Claude changed and did not commit yet (files, lines added and removed), dependencies added since the session's first scan (in `package.json`, `requirements.txt`, `pyproject.toml` with its PEP 621, PEP 735 and Poetry lists, and `Cargo.toml`), source files changed with no test changed, and possible secrets (private keys; AWS, GitHub, Anthropic, OpenAI, Slack, Stripe and Google keys) in the files it changed |

A dependency counts once it is in a manifest: `npm install x`, `uv add x`, `poetry add x` and `cargo add x` write one, `pip install x` does not.

The npm checks run where the `package.json` is: in a monorepo, the package you started Claude in. The git checks run from the repository's top folder. A check that times out keeps its previous lines rather than dropping them, and none of them can throw: a broken check never breaks the interface. A check that cannot run says why at the bottom of the pane: the command could not start (not installed, or not on the PATH the app sees), it timed out, or `npm audit` found no `package-lock.json`. The branch you have checked out never counts as stale.

## Why a mod and not a status line

The original idle-intel was a bash script wired into `statusLine`. The mod version fixes what that could not:

- **It knows when you're actually waiting.** `turn.start` and `turn.complete` are real events, so the briefing appears during the wait and leaves when work resumes — no 12-second guessing.
- **It's installable.** `/plugin install`, nothing to edit in `settings.json`, no `.cmd` wrapper, no three copies of `bash.exe` fighting over one command on Windows.
- **It can act.** A status line can only print. A mod can carry a button that submits a prompt.

## Install

```
/plugin install idle-mod --marketplace demartinogiuseppe/idle-mod
```

In the Desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `demartinogiuseppe/idle-mod`, then **Add plugin**.

Or in two steps: `/plugin marketplace add demartinogiuseppe/idle-mod`, then `/plugin install idle-mod@idle-mod`.

To try it before installing, clone this repo and run `claude --plugin-dir ./idle-mod` from your project.

## Requirements

| Needs | For | Get it |
|---|---|---|
| Claude Code with mod support | the mod itself | built and tested on v2.1.301; `claude --version` to check, `claude update` to update |
| Git | git checks, TODO/FIXME count | [git-scm.com/downloads](https://git-scm.com/downloads) |
| Node.js with npm | npm checks, only in projects with a `package.json` | [nodejs.org/en/download](https://nodejs.org/en/download) |

The mod API is in early access and may change between releases, so an older or much newer Claude Code may not load it. If `/idle-mod` is not a valid command after a restart, the mod did not load, and it cannot tell you why from inside: check the version first.

When Git or npm is missing, the pane says which check did not run and links to where to get it. If it is installed but the pane still says it could not start, the app does not see it on its PATH: check that `git --version` (or `npm --version`) works in a new terminal, then restart the app.

## What it sends, and where it runs

No telemetry, no server of ours, no account. The briefings never call the model, so they cost zero tokens; only pressing **Fix with Claude** sends a prompt, the same as typing it yourself. The findings tool's name sits in Claude's tool list like any tool's, a few tokens, and its answer is read by the model only when Claude calls it.

What does leave your machine: in a project with a `package.json`, the mod runs `npm audit` and `npm outdated` when a session starts, and again when you start a turn or open the pane and the last scan is more than 30 minutes old. Like running those commands yourself, they send your dependency names and versions to the npm registry in your npm configuration. Everything else (git and the TODO/FIXME count) stays local.

The last scan of each of your 20 most recent projects is saved on your machine, under Claude Code's configuration folder, so the next session can show it right away. It holds the project's path and the finding lines, nothing else. The lines you ignore are saved there too, per project: the line's text, or a secret's file and kind. So is each session's share for the others: its lines, without the repo's own text, for a day.

**Opening a repo you don't trust.**

- A project's own `.npmrc` can send npm to any host and fill its values from your environment variables, so a cloned repo could have npm hand your tokens to that host. npm has no option to ignore that file, so the mod **skips the npm checks in any project that has its own `.npmrc`** and says so in the pane. That includes an `.npmrc` in any folder between the package and the repo's top, since npm 10 reads a workspace root's file too; one above the repo's top is yours and does not count. Run `npm audit` yourself there if you trust the file.
- A repo's `.git/config` can name programs for git to run. Every git command runs with `-c core.fsmonitor=false -c log.showSignature=false -c submodule.recurse=false`, which keeps `git grep` and `git log` from starting one and git out of submodules the repo brings along, and every npm command with `--git=git`. The names of the files changed this session reach `git grep` after `--` with `--literal-pathspecs`, so a file name is never read as a pattern or an option. A FIXME's comment is the repo's text: the pane shows it as plain ASCII, cut short, and its **Fix with Claude** prompt names only the file and line, never the comment, so a comment cannot write the prompt. What the session changed is compared with the last commit through `git cat-file`, which reads git's own objects, never with `git diff` or `git status`, which would run a repo's filters on your files. A possible secret is shown by its kind, file and line only: its value is never drawn, saved or put in a prompt.
- Package names and versions are dropped unless they have their ecosystem's own format (npm, PyPI, crates.io), and branch names are shown as plain ASCII, so text from the repo cannot carry control characters or sentences into the pane or a prompt. Counts can still be faked by a repo, so read a finding before you act on it.

One thing to know before you install this or any other mod: **mods are not sandboxed.** Through Claude Code they can run programs and read files on your machine. Read the source before you trust it — it's one file, `hooks/register.js`, and you can list what it does without running it:

```
claude plugin validate ./idle-mod
```

The `hooks:` and `calls:` lines tell you every event it handles and everything it asks Claude Code to do.

The band and the pane are drawn in the terminal and in the Desktop app's Code tab. Where nothing is drawn (`claude -p`, CI, an SDK script with no app attached) the mod runs no checks of its own, unless the `headless` option is on or Claude calls the findings tool.

## Test before you trust

`test-kit/make-demo.sh` builds a disposable project containing **seven planted defects** — a real lodash CVE, a major version jump (chalk 4 → latest), two unpushed commits against a local fake remote, a stash, a branch backdated 45 days, and known TODO/FIXME counts — so you can check every collector against an answer written down in advance. The demo installs a package with a known vulnerability on purpose: keep it in its own folder, never run its code, and delete it when you're done.

It needs bash, git, npm and Python 3. Run it from an empty folder outside this repo:

```bash
mkdir idle-mod-try && cd idle-mod-try
bash /path/to/idle-mod/test-kit/make-demo.sh
cd idle-intel-demo
claude --plugin-dir /path/to/idle-mod
```

Then run `/idle-mod`, open **In the project** and count: the seven defects were there before the session started, so they are the project's. Expected: 7 of 7. To see a session line, ask Claude to add a `// FIXME: test` comment to `src/app.js`: after that turn it shows under **This session**, with its file and line, and in the band. Run it twice — once in the terminal, once in the Desktop app — because those are two separate installs of Claude Code, and a mod built against one can break on the other.

That discipline comes from twenty years of food production auditing: you don't validate an inspection system by pointing it at something and hoping. You plant known defects and verify it finds exactly those.

## License

MIT. No server, no business model, free by construction.

idle-mod is an independent project, not made, affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic, used here only to say what the mod works with.
