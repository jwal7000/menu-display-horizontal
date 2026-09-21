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
LOG="$REPO_H/logs/refresh.log"

GITHUB_TOKEN=$(cat /tmp/ghtoken.txt 2>/dev/null || \
  python3 -c "import json; print(json.load(open('/Users/openclaw-user/.openclaw/secrets/menu-refresh.json'))['github_token'])")
GOOGLE_SHEETS_ID=$(python3 -c "import json; print(json.load(open('/Users/openclaw-user/.openclaw/secrets/menu-refresh.json'))['sheets_id'])")
SQUARE_TOKEN=$(python3 -c "import json; print(json.load(open('/Users/openclaw-user/.openclaw/secrets/square.json'))['access_token'])")

mkdir -p "$(dirname "$LOG")"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting menu refresh..." >> "$LOG"

cd "$REPO_H"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# 1. Build canonical menu from Google Sheets → output/data/12th-south.json (+ any sheet locations)
GOOGLE_SHEETS_ID="$GOOGLE_SHEETS_ID" \
SQUARE_ACCESS_TOKEN="$SQUARE_TOKEN" \
npm run build-menu-sheets >> "$LOG" 2>&1

# 2. Replicate canonical to horizontal displays (The Gulch)
node -e "
  const fs = require('fs'), path = require('path');
  const src = JSON.parse(fs.readFileSync('output/data/12th-south.json', 'utf8'));
  const locs = [
    { slug: 'the-gulch', name: 'The Gulch', sqId: 'L4CQJADFVPZC9' },
  ];
  for (const loc of locs) {
    const m = JSON.parse(JSON.stringify(src));
    m.location_id = loc.sqId; m.location_name = loc.name; m.generated_at = new Date().toISOString();
    fs.writeFileSync(path.resolve('output/data', loc.slug + '.json'), JSON.stringify(m, null, 2));
    console.log('Replicated (horizontal):', loc.slug);
  }
" >> "$LOG" 2>&1

# 3. Replicate canonical to portrait displays (The Factory, 5th & Broadway)
node -e "
  const fs = require('fs'), path = require('path');
  const src = JSON.parse(fs.readFileSync('output/data/12th-south.json', 'utf8'));
  const repoP = '$REPO_P';
  const locs = [
    { slug: 'the-factory', name: 'The Factory',    sqId: 'ECE7YC9G73NXK' },
    { slug: '5th-broad',   name: '5th & Broadway', sqId: 'L862ACB6EPKVT' },
  ];
  fs.mkdirSync(path.join(repoP, 'output/data'), { recursive: true });
  for (const loc of locs) {
    const m = JSON.parse(JSON.stringify(src));
    m.location_id = loc.sqId; m.location_name = loc.name; m.generated_at = new Date().toISOString();
    fs.writeFileSync(path.join(repoP, 'output/data', loc.slug + '.json'), JSON.stringify(m, null, 2));
    console.log('Replicated (portrait):', loc.slug);
  }
" >> "$LOG" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Replication done." >> "$LOG"

# 4. Push horizontal repo (The Gulch)
git -C "$REPO_H" add output/data/*.json
if git -C "$REPO_H" diff --cached --quiet; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Horizontal: no changes." >> "$LOG"
else
  git -C "$REPO_H" -c user.name="menu-refresh[bot]" \
      -c user.email="menu-refresh@fivedaughtersbakery.com" \
      commit -m "chore: auto-refresh menu data [$(date '+%H:%M')]" >> "$LOG" 2>&1
  GIT_ASKPASS='' git -C "$REPO_H" -c credential.helper='' push \
    "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-horizontal.git" main >> "$LOG" 2>&1
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Horizontal: pushed." >> "$LOG"
fi

# 5. Push portrait repo (The Factory, 5th & Broadway)
git -C "$REPO_P" add output/data/*.json 2>/dev/null || true
if git -C "$REPO_P" diff --cached --quiet; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Portrait: no changes." >> "$LOG"
else
  git -C "$REPO_P" -c user.name="menu-refresh[bot]" \
      -c user.email="menu-refresh@fivedaughtersbakery.com" \
      commit -m "chore: auto-refresh menu data [$(date '+%H:%M')]" >> "$LOG" 2>&1
  GIT_ASKPASS='' git -C "$REPO_P" -c credential.helper='' push \
    "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-portrait.git" main >> "$LOG" 2>&1
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Portrait: pushed." >> "$LOG"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done." >> "$LOG"
