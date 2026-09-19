#!/bin/zsh
# refresh-menu.sh
# Rebuilds menu.json from Google Sheets + Square inventory, then commits and pushes.
# Designed to run every 10 minutes via launchd.

set -e

REPO="/Users/openclaw-user/.openclaw/workspace/square-digital-menu-poc"
LOG="/Users/openclaw-user/.openclaw/workspace/square-digital-menu-poc/logs/refresh.log"
# Credentials — sourced from environment or secrets file
GITHUB_TOKEN=$(python3 -c "import json; print(json.load(open('/Users/openclaw-user/.openclaw/secrets/menu-refresh.json'))['github_token'])" 2>/dev/null || echo "")
GOOGLE_SHEETS_ID=$(python3 -c "import json; print(json.load(open('/Users/openclaw-user/.openclaw/secrets/menu-refresh.json'))['sheets_id'])" 2>/dev/null || echo "")
SQUARE_TOKEN=$(python3 -c "import json; print(json.load(open('/Users/openclaw-user/.openclaw/secrets/square.json'))['access_token'])")

mkdir -p "$(dirname "$LOG")"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting menu refresh..." >> "$LOG"

cd "$REPO"

# Add node/npm to PATH
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Build from Google Sheets (generates output/data/12th-south.json and any other sheet locations)
GOOGLE_SHEETS_ID="$GOOGLE_SHEETS_ID" \
SQUARE_ACCESS_TOKEN="$SQUARE_TOKEN" \
npm run build-menu-sheets >> "$LOG" 2>&1

# Replicate canonical menu to each active display location (same items, location-specific name)
# Inventory is patched separately every 2 minutes by refresh-inventory.sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node -e "
  const fs = require('fs'), path = require('path');
  const canonical = JSON.parse(fs.readFileSync('output/data/12th-south.json', 'utf8'));
  const displays = [
    { slug: 'the-factory', name: 'The Factory',   sqId: 'ECE7YC9G73NXK' },
    { slug: 'the-gulch',   name: 'The Gulch',      sqId: 'L4CQJADFVPZC9' },
    { slug: '5th-broad',   name: '5th & Broadway', sqId: 'L862ACB6EPKVT' },
  ];
  for (const loc of displays) {
    const menu = JSON.parse(JSON.stringify(canonical));
    menu.location_id   = loc.sqId;
    menu.location_name = loc.name;
    menu.generated_at  = new Date().toISOString();
    fs.writeFileSync(path.resolve('output/data', loc.slug + '.json'), JSON.stringify(menu, null, 2));
    console.log('Replicated', loc.slug);
  }
" >> "$LOG" 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Display location files replicated." >> "$LOG"

# Commit and push if any location data changed
git add output/data/*.json

if git diff --cached --quiet; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] No changes — skipping push." >> "$LOG"
else
  git -c user.name="menu-refresh[bot]" \
      -c user.email="menu-refresh@fivedaughtersbakery.com" \
      commit -m "chore: auto-refresh menu data [$(date '+%H:%M')]" >> "$LOG" 2>&1

  GIT_ASKPASS='' git -c credential.helper='' \
    push "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-horizontal.git" main >> "$LOG" 2>&1

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pushed updated menu data." >> "$LOG"
fi

# Sync factory menu to portrait project
PORTRAIT_OUTPUT="/Users/openclaw-user/.openclaw/workspace/square-digital-menu-poc-portrait/output/menu.json"
cp "$REPO/output/data/the-factory.json" "$PORTRAIT_OUTPUT" 2>/dev/null && \
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Synced menu.json to portrait project." >> "$LOG" || \
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: failed to sync menu.json to portrait project." >> "$LOG"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done." >> "$LOG"
