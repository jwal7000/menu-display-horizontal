#!/bin/zsh
# refresh-menu.sh
# Rebuilds menu data from Google Sheets, replicates to per-location files,
# and pushes each layout repo separately.
#
# Layout split:
#   Horizontal repo (menu-display-horizontal) → The Gulch
#   Portrait repo   (menu-display-portrait)   → The Factory, 5th & Broadway
#
# Runs every 10 minutes via launchd.

set -e

REPO_H="/Users/openclaw-user/.openclaw/workspace/square-digital-menu-poc"
REPO_P="/Users/openclaw-user/.openclaw/workspace/square-digital-menu-poc-portrait"
REPO_B="/Users/openclaw-user/.openclaw/workspace/menu-display-beverages"
LOG="$REPO_H/logs/refresh.log"

GITHUB_TOKEN=$(cat /tmp/ghtoken.txt 2>/dev/null || \
  python3 -c "import json; print(json.load(open('/Users/openclaw-user/.openclaw/secrets/menu-refresh.json'))['github_token'])")
GOOGLE_SHEETS_ID=$(python3 -c "import json; print(json.load(open('/Users/openclaw-user/.openclaw/secrets/menu-refresh.json'))['sheets_id'])")
SQUARE_TOKEN=$(python3 -c "import json; print(json.load(open('/Users/openclaw-user/.openclaw/secrets/square.json'))['access_token'])")

mkdir -p "$(dirname "$LOG")"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting menu refresh..." >> "$LOG"


# push_repo DIR URL BRANCH LABEL
# Pushes DIR's BRANCH. If GitHub rejects it because the remote moved (e.g. the beverages
# admin page committed), rebase onto the remote and push again. A failure is logged and
# remembered, but never stops the other repos from updating.
FAILED=0
push_repo() {
  local dir="$1" url="$2" branch="$3" label="$4"
  if GIT_ASKPASS='' git -C "$dir" -c credential.helper='' push "$url" "$branch" >> "$LOG" 2>&1; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $label: pushed." >> "$LOG"; return 0
  fi
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $label: push rejected; rebasing onto remote and retrying." >> "$LOG"
  if GIT_ASKPASS='' git -C "$dir" -c credential.helper='' -c user.name="menu-refresh[bot]" \
       -c user.email="menu-refresh@fivedaughtersbakery.com" pull --rebase --autostash "$url" "$branch" >> "$LOG" 2>&1 \
     && GIT_ASKPASS='' git -C "$dir" -c credential.helper='' push "$url" "$branch" >> "$LOG" 2>&1; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $label: pushed after rebase." >> "$LOG"; return 0
  fi
  git -C "$dir" rebase --abort >/dev/null 2>&1 || true
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $label: PUSH FAILED (left local commits in place)." >> "$LOG"
  FAILED=1
}

cd "$REPO_H"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Build pastry menu from AppSheet/SQL FlavorSchedule + Square catalog prices + Square inventory
npm run build-menu-db >> "$LOG" 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pastry build complete." >> "$LOG"

# Build beverage menu and copy data to beverages repo
npm run build-bev >> "$LOG" 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bev build complete." >> "$LOG"
mkdir -p "$REPO_B/public/data"
for f in "$REPO_H/output/data/bev-"*.json; do
  [[ -f "$f" ]] && cp "$f" "$REPO_B/public/data/"
done
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bev data copied to beverages repo." >> "$LOG"

# Copy portrait locations to the portrait repo
for loc in the-factory 5th-broad; do
  src="$REPO_H/output/data/${loc}.json"
  dst="$REPO_P/output/data/${loc}.json"
  if [[ -f "$src" ]]; then
    cp "$src" "$dst"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Copied ${loc}.json → portrait repo." >> "$LOG"
  fi
done

# 4. Push horizontal repo (The Gulch)
git -C "$REPO_H" add -- 'output/data/*.json'
if git -C "$REPO_H" diff --cached --quiet; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Horizontal: no changes." >> "$LOG"
else
  git -C "$REPO_H" -c user.name="menu-refresh[bot]" \
      -c user.email="menu-refresh@fivedaughtersbakery.com" \
      commit -m "chore: auto-refresh menu data [$(date '+%H:%M')]" >> "$LOG" 2>&1
  push_repo "$REPO_H" "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-horizontal.git" main "Horizontal"
fi

# 5. Push portrait repo (The Factory, 5th & Broadway)
git -C "$REPO_P" add -- 'output/data/*.json' >> "$LOG" 2>&1 || echo "[$(date '+%Y-%m-%d %H:%M:%S')] Portrait: git add FAILED" >> "$LOG"
if git -C "$REPO_P" diff --cached --quiet; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Portrait: no changes." >> "$LOG"
else
  git -C "$REPO_P" -c user.name="menu-refresh[bot]" \
      -c user.email="menu-refresh@fivedaughtersbakery.com" \
      commit -m "chore: auto-refresh menu data [$(date '+%H:%M')]" >> "$LOG" 2>&1
  push_repo "$REPO_P" "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-portrait.git" main "Portrait"
fi

# 6. Push beverages repo (The Gulch, Medley)
git -C "$REPO_B" add -- 'public/data/bev-*.json' >> "$LOG" 2>&1 || echo "[$(date '+%Y-%m-%d %H:%M:%S')] Beverages: git add FAILED" >> "$LOG"
if git -C "$REPO_B" diff --cached --quiet; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Beverages: no changes." >> "$LOG"
else
  git -C "$REPO_B" -c user.name="menu-refresh[bot]" \
      -c user.email="menu-refresh@fivedaughtersbakery.com" \
      commit -m "chore: auto-refresh bev data [$(date '+%H:%M')]" >> "$LOG" 2>&1
  push_repo "$REPO_B" "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-beverages.git" main "Beverages"
fi

# 7. Push data to gh-pages branch (serves GitHub Pages directly without Actions)
GH_PAGES_WORKTREE="$REPO_H/.gh-pages-worktree"
if [[ ! -d "$GH_PAGES_WORKTREE" ]]; then
  git -C "$REPO_H" worktree add "$GH_PAGES_WORKTREE" gh-pages 2>/dev/null || true
fi
if [[ -d "$GH_PAGES_WORKTREE/.git" || -f "$GH_PAGES_WORKTREE/.git" ]]; then
  mkdir -p "$GH_PAGES_WORKTREE/data"
  cp "$REPO_H/output/data/"*.json "$GH_PAGES_WORKTREE/data/" 2>/dev/null || true
  git -C "$GH_PAGES_WORKTREE" add -- 'data/*.json' >> "$LOG" 2>&1 || echo "[$(date '+%Y-%m-%d %H:%M:%S')] gh-pages: git add FAILED" >> "$LOG"
  if git -C "$GH_PAGES_WORKTREE" diff --cached --quiet; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] gh-pages: no data changes." >> "$LOG"
  else
    git -C "$GH_PAGES_WORKTREE" -c user.name="menu-refresh[bot]" \
        -c user.email="menu-refresh@fivedaughtersbakery.com" \
        commit -m "chore: auto-refresh menu data [$(date '+%H:%M')]" >> "$LOG" 2>&1
    push_repo "$GH_PAGES_WORKTREE" "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-horizontal.git" gh-pages "gh-pages"
  fi
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done (push failures: $FAILED)." >> "$LOG"
exit $FAILED
