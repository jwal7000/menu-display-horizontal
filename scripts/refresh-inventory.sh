#!/bin/zsh
# refresh-inventory.sh
# Fetches Square inventory counts for each active display location, patches
# their menu JSON, and pushes to GitHub only when sold_out status changes.
# Runs every 2 minutes via launchd (com.fivedaughters.inventory-sync).

set -e

REPO="/Users/openclaw-user/.openclaw/workspace/square-digital-menu-poc"
PORTRAIT="/Users/openclaw-user/.openclaw/workspace/square-digital-menu-poc-portrait"
LOG="$REPO/logs/inventory.log"
GITHUB_TOKEN=*** -c "import json; print(json.load(open('/Users/openclaw-user/.openclaw/secrets/menu-refresh.json'))['github_token'])" 2>/dev/null || echo "")

mkdir -p "$(dirname "$LOG")"
cd "$REPO"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Inventory sync start..." >> "$LOG"

# ── Active display locations ─────────────────────────────────────────────────
# Format: "slug:SquareLocationID"
LOCATIONS=(
  "the-factory:ECE7YC9G73NXK"
  "the-gulch:L4CQJADFVPZC9"
  "5th-broad:L862ACB6EPKVT"
)

for entry in "${LOCATIONS[@]}"; do
  SLUG="${entry%%:*}"
  LOCATION_ID="${entry##*:}"

  MENU_FILE="$REPO/output/data/${SLUG}.json"
  INVENTORY_FILE="$REPO/output/inventory-${SLUG}.json"

  # Skip if no menu file exists yet (first run before rebuild)
  if [[ ! -f "$MENU_FILE" ]]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Skipping ${SLUG} — menu file not found yet." >> "$LOG"
    continue
  fi

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Checking ${SLUG} (location: ${LOCATION_ID})..." >> "$LOG"

  # 1. Fetch live inventory for this location
  SQUARE_LOCATION_ID="$LOCATION_ID" \
  INVENTORY_OUTPUT="$INVENTORY_FILE" \
  node src/fetchInventory.js >> "$LOG" 2>&1

  # 2. Patch sold_out flags in this location's menu.json
  MENU_FILE="$MENU_FILE" \
  INVENTORY_FILE="$INVENTORY_FILE" \
  node src/patchMenuInventory.js >> "$LOG" 2>&1
done

# ── Sync portrait project (still uses the-factory data) ─────────────────────
FACTORY_MENU="$REPO/output/data/the-factory.json"
FACTORY_INV="$REPO/output/inventory-the-factory.json"

cp "$FACTORY_MENU" "$PORTRAIT/output/menu.json" 2>/dev/null && \
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✓ factory menu.json → portrait" >> "$LOG" || \
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: failed to sync to portrait" >> "$LOG"

cp "$FACTORY_INV" "$PORTRAIT/output/inventory.json" 2>/dev/null && \
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✓ factory inventory.json → portrait" >> "$LOG" || \
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: failed to sync inventory to portrait" >> "$LOG"

# ── Push to GitHub if any sold_out status changed ────────────────────────────
git add output/data/*.json
if git diff --cached --quiet; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] No sold_out changes — skipping push." >> "$LOG"
else
  GIT_ASKPASS='' git -c credential.helper='' \
    pull --rebase "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-horizontal.git" main >> "$LOG" 2>&1

  git -c user.name="inventory-sync[bot]" \
      -c user.email="inventory-sync@fivedaughtersbakery.com" \
      commit -m "chore: update sold_out flags [$(date '+%H:%M')]" >> "$LOG" 2>&1

  GIT_ASKPASS='' git -c credential.helper='' \
    push "https://${GITHUB_TOKEN}@github.com/jwal7000/menu-display-horizontal.git" main >> "$LOG" 2>&1

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pushed sold_out updates." >> "$LOG"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done." >> "$LOG"
