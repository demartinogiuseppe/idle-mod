#!/usr/bin/env bash
# Builds a disposable demo project with seven planted defects, so you can
# verify every collector against a known answer before trusting the mod.
#
#   1. npm audit: high severity vuln   (lodash 4.17.15, real CVE)
#   2. major update available          (chalk 4.1.2, latest is 5+)
#   3. 2 unpushed commits              (against a local fake remote)
#   4. 1 stash
#   5. 1 branch untouched 30+ days     (backdated 45 days)
#   6. 2 FIXME markers
#   7. 3 TODO markers
#
# Usage: bash make-demo.sh   (run it in an empty directory)
# Undo:  rm -rf idle-intel-demo idle-intel-demo-remote.git

set -e
ROOT="$PWD/idle-intel-demo"
[ -e "$ROOT" ] || [ -e "${ROOT}-remote.git" ] && { echo "idle-intel-demo or idle-intel-demo-remote.git already exists here. Delete both first."; exit 1; }

# Pick the first interpreter that actually runs: on Windows, python3 is often
# a Microsoft Store stub that is on PATH but only prints an install hint.
PY=""
for c in python3 python py; do "$c" -c "" >/dev/null 2>&1 && { PY=$c; break; }; done
[ -z "$PY" ] && { echo "python or python3 is required to backdate commits."; exit 1; }

echo "== Building demo project in $ROOT"
mkdir -p "$ROOT/src"
cd "$ROOT"

cat > src/app.js <<'EOF'
// TODO: extract config to env
// FIXME: race condition on concurrent writes
function main() {
  // TODO: add input validation
  return process(load());
}
EOF
cat > src/utils.js <<'EOF'
// TODO: replace with native structuredClone
// FIXME: leaks listeners on hot reload
module.exports = { clone: (x) => JSON.parse(JSON.stringify(x)) };
EOF

git init -q
git config user.email demo@idle-intel.test
git config user.name "idle-intel demo"
# Your own git settings stay out of the demo: no signing prompts, no hooks.
git config commit.gpgsign false
git config core.hooksPath .git/no-hooks

# A local bare repo stands in for the remote, so the unpushed-commit check
# works with no network at all.
git init -q --bare ../idle-intel-demo-remote.git
git remote add origin ../idle-intel-demo-remote.git

DATE60=$("$PY" -c "import datetime as d; print((d.datetime.now()-d.timedelta(days=60)).strftime('%Y-%m-%dT%H:%M:%S'))")
DATE45=$("$PY" -c "import datetime as d; print((d.datetime.now()-d.timedelta(days=45)).strftime('%Y-%m-%dT%H:%M:%S'))")

git add -A
GIT_AUTHOR_DATE="$DATE60" GIT_COMMITTER_DATE="$DATE60" git commit -qm "initial commit"
git branch -M main
git push -qu origin main

git checkout -qb old-experiment
echo "// abandoned" >> src/utils.js
git add -A
GIT_AUTHOR_DATE="$DATE45" GIT_COMMITTER_DATE="$DATE45" git commit -qm "experiment"
git checkout -q main

echo "// v2" >> src/app.js && git add -A && git commit -qm "wip 1"
echo "// v3" >> src/app.js && git add -A && git commit -qm "wip 2"

echo "// uncommitted idea" >> src/utils.js
git stash -q

cat > package.json <<'EOF'
{
  "name": "idle-intel-demo",
  "version": "1.0.0",
  "private": true,
  "dependencies": { "lodash": "4.17.15", "chalk": "4.1.2" }
}
EOF
echo "-- running npm install (needed for npm audit; ~30s)..."
npm install --silent --no-fund --no-audit

echo ""
echo "== Demo ready. Now, in a shell:"
echo "   cd \"$ROOT\""
echo "   claude --plugin-dir /path/to/idle-mod"
echo "   then run /idle-mod in the session"
echo ""
echo "== The defects predate the session, so they are the project's:"
echo "   open 'show the project lines' and verify all seven:"
echo "   - npm audit: high severity (lodash CVE)"
echo "   - major update: chalk"
echo "   - 2 unpushed commits"
echo "   - 1 stash"
echo "   - 1 branch untouched 30+ days (old-experiment)"
echo "   - 2 FIXME markers"
echo "   - 3 TODO markers"
echo ""
echo "== Run the same check twice: once in the terminal, once in the"
echo "   Desktop app's Code tab. They are separate Claude Code installs."
echo ""
echo "== Cleanup: rm -rf \"$ROOT\" \"${ROOT}-remote.git\""
