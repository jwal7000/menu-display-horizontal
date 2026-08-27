#!/bin/zsh
# refresh-inventory.sh
# Fetches Square inventory counts, patches menu.json sold_out flags, and syncs
# both files to the portrait display project.
# Runs every 2 minutes via launchd (com.fivedaughters.inventory-sync).
# Pushes to GitHub only when sold_out status actually changes.
#
# Square Location IDs (update when display location changes):
#   The Factory:      ECE7YC9G73NXK
#   5th & Broadway:   L862ACB6EPKVT
#   The Gulch:        L4CQJADFVPZC9
#   12th South:       AX2YMJVN8QJ7C
#   East:             FXG8HKPA0CFDV
#   L&L Market:       KT6WPWXNTSBB8
#   Ponce City Market:L3VJ4QYD3NCPK
#   The Fountains:    LFCKHR2CKGE9X
#   Westside Provisions: L1ZBPSYJ6T2Y3
#   Avalon:           LCEVX3XQTM8WP

set -e

REPO="/Users/openclaw-user/.openclaw/workspace/square-digital-menu-poc"
PORTRAIT="/Users/openclaw-user/.openclaw/workspace/square-digital-menu-poc-portrait"
LOG="$REPO/logs/inventory.log"
GITHUB_TOKEN=$(python3 -c "import json; print(json.load(open('/Users/openclaw-user/.openclaw/secrets/menu-refresh.json'))['github_token'])" 2>/dev/null || echo "")

# Primary location for inventory check (portrait screens are at The Factory)
SQUARE_LOCATION_ID="ECE7YC9G73NXK"

mkdir -p "$(dirname "$LOG")"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Inventory sync start (location: $SQUARE_LOCATION_ID)..." >> "$LOG"

cd "$REPO"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# 1. Fetch live inventory from Square → output/inventory.json
SQUARE_LOCATION_ID="$SQUARE_LOCATION_ID" \
node src/fetchInventory.js >> "$LOG" 2>&1

# 2. Patch sold_out flags in output/menu.json
node src/patchMenuInventory.js >> "$LOG" 2>&1

# 3. Push to GitHub only if sold_out status changed
git add output/menu.json
if git diff --cached --quiet; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] No sold_out changes — skipping push." >> "$LOG"
else
  # Pull first to avoid non-fast-forward conflicts with the 10-min rebuild
  GIT_ASKPASS='' git -c credential.helper='' \
    pull --rebase "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-horizontal.git" main >> "$LOG" 2>&1

  git -c user.name="inventory-sync[bot]" \
      -c user.email="inventory-sync@fivedaughtersbakery.com" \
      commit -m "chore: update sold_out flags [$(date '+%H:%M')]" >> "$LOG" 2>&1

  GIT_ASKPASS='' git -c credential.helper='' \
    push "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-horizontal.git" main >> "$LOG" 2>&1

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pushed sold_out update." >> "$LOG"
fi

# 4. Sync both files to portrait project so its server always has fresh data
cp "$REPO/output/menu.json"      "$PORTRAIT/output/menu.json" 2>/dev/null && \
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✓ menu.json → portrait" >> "$LOG" || \
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: failed to sync menu.json" >> "$LOG"

cp "$REPO/output/inventory.json" "$PORTRAIT/output/inventory.json" 2>/dev/null && \
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✓ inventory.json → portrait" >> "$LOG" || \
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: failed to sync inventory.json" >> "$LOG"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done." >> "$LOG"
