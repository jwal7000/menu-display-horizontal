#!/bin/zsh
# refresh-inventory.sh
# Fetches Square inventory for each display location, patches its menu JSON,
# and pushes to the correct GitHub repo only when sold_out status changes.
# Runs every 2 minutes via launchd (com.fivedaughters.inventory-sync).
#
# Layout split:
#   Horizontal repo (menu-display-horizontal) → The Gulch
#   Portrait repo   (menu-display-portrait)   → The Factory, 5th & Broadway

set -e

REPO_H="/Users/openclaw-user/.openclaw/workspace/square-digital-menu-poc"
REPO_P="/Users/openclaw-user/.openclaw/workspace/square-digital-menu-poc-portrait"
LOG="$REPO_H/logs/inventory.log"
GITHUB_TOKEN=$(cat /tmp/ghtoken.txt 2>/dev/null || \
  python3 -c "import json; print(json.load(open('/Users/openclaw-user/.openclaw/secrets/menu-refresh.json'))['github_token'])")

mkdir -p "$(dirname "$LOG")"
cd "$REPO_H"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Inventory sync start..." >> "$LOG"

# ── Horizontal locations (push to menu-display-horizontal) ───────────────────
HORIZONTAL_LOCATIONS=(
  "the-gulch:L4CQJADFVPZC9"
)

for entry in "${HORIZONTAL_LOCATIONS[@]}"; do
  SLUG="${entry%%:*}"; LOC_ID="${entry##*:}"
  MENU_FILE="$REPO_H/output/data/${SLUG}.json"
  INV_FILE="$REPO_H/output/inventory-${SLUG}.json"
  [[ ! -f "$MENU_FILE" ]] && { echo "[$(date '+%Y-%m-%d %H:%M:%S')] Skipping ${SLUG} — no menu file." >> "$LOG"; continue; }
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [horizontal] ${SLUG} (${LOC_ID})..." >> "$LOG"
  SQUARE_LOCATION_ID="$LOC_ID" INVENTORY_OUTPUT="$INV_FILE" node src/fetchInventory.js >> "$LOG" 2>&1
  MENU_FILE="$MENU_FILE" INVENTORY_FILE="$INV_FILE" node src/patchMenuInventory.js >> "$LOG" 2>&1
done

git -C "$REPO_H" add output/data/*.json
if git -C "$REPO_H" diff --cached --quiet; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Horizontal: no sold_out changes." >> "$LOG"
else
  GIT_ASKPASS='' git -C "$REPO_H" -c credential.helper='' pull --rebase \
    "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-horizontal.git" main >> "$LOG" 2>&1
  git -C "$REPO_H" -c user.name="inventory-sync[bot]" \
      -c user.email="inventory-sync@fivedaughtersbakery.com" \
      commit -m "chore: update sold_out flags [$(date '+%H:%M')]" >> "$LOG" 2>&1
  GIT_ASKPASS='' git -C "$REPO_H" -c credential.helper='' push \
    "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-horizontal.git" main >> "$LOG" 2>&1
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Horizontal: pushed." >> "$LOG"
fi

# ── Portrait locations (push to menu-display-portrait) ──────────────────────
PORTRAIT_LOCATIONS=(
  "the-factory:ECE7YC9G73NXK"
  "5th-broad:L862ACB6EPKVT"
)

for entry in "${PORTRAIT_LOCATIONS[@]}"; do
  SLUG="${entry%%:*}"; LOC_ID="${entry##*:}"
  MENU_FILE="$REPO_P/output/data/${SLUG}.json"
  INV_FILE="$REPO_P/output/inventory-${SLUG}.json"
  [[ ! -f "$MENU_FILE" ]] && { echo "[$(date '+%Y-%m-%d %H:%M:%S')] Skipping portrait ${SLUG} — no menu file." >> "$LOG"; continue; }
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [portrait] ${SLUG} (${LOC_ID})..." >> "$LOG"
  SQUARE_LOCATION_ID="$LOC_ID" INVENTORY_OUTPUT="$INV_FILE" node src/fetchInventory.js >> "$LOG" 2>&1
  MENU_FILE="$MENU_FILE" INVENTORY_FILE="$INV_FILE" node src/patchMenuInventory.js >> "$LOG" 2>&1
done

git -C "$REPO_P" add output/data/*.json 2>/dev/null || true
if git -C "$REPO_P" diff --cached --quiet; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Portrait: no sold_out changes." >> "$LOG"
else
  GIT_ASKPASS='' git -C "$REPO_P" -c credential.helper='' pull --rebase \
    "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-portrait.git" main >> "$LOG" 2>&1
  git -C "$REPO_P" -c user.name="inventory-sync[bot]" \
      -c user.email="inventory-sync@fivedaughtersbakery.com" \
      commit -m "chore: update sold_out flags [$(date '+%H:%M')]" >> "$LOG" 2>&1
  GIT_ASKPASS='' git -C "$REPO_P" -c credential.helper='' push \
    "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-portrait.git" main >> "$LOG" 2>&1
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Portrait: pushed." >> "$LOG"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done." >> "$LOG"
