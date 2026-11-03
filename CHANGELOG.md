# Digital Menu Board — Change Log

**Repo:** https://github.com/jwal7000/menu-display  
**Preview:** https://jwal7000.github.io/menu-display/public/  
**Target display:** 16:9 TV (1920×1080 reference, scales with vw/vh)

---

## 2026-11-03 — Cloud Run Jobs migration (branch `cloud-run-jobs`)

Pipeline can now run as two Cloud Run Jobs (`menu-build` every 10 min, `inventory-sync` every 2 min) instead of the Mac mini launchd scripts. See `cloudrun/README.md` for deploy, cutover and rollback.

- Credentials from env vars (Secret Manager on Cloud Run), falling back to `~/.openclaw/secrets/*` on the Mac mini
- Cloud SQL via connector socket when `MYSQL_SOCKET` is set; otherwise the local proxy on 3307 as before
- `bev-items-config.json` read from GCS when `BEV_CONFIG_URL` is set
- Location list shared in `src/lib/locations.js`
- Fix: single-size menu items now carry `variation_id`, so the 2-min sold-out sync can match them
- Fix: `patchMenuInventory` only rewrites a menu file when a sold-out flag changes
- New: stateless git publisher with retry (`src/jobs/publish.js`), `Dockerfile`, `cloudrun/deploy-menu-jobs.sh`, tests (`npm test`)

---

## 2026-08-13 — Session with Gabe

### `8f8e023` — Force 3-column grid; remove scroll for TV display
Problem: `auto-fill` columns at `22vw` min only fit 2 columns in the 64vw content area, producing 3 rows that overflowed the viewport and required scrolling — unusable on a static TV.

Fix:
- `.sections-grid` changed from `repeat(auto-fill, minmax(22vw, 1fr))` → `repeat(3, 1fr)` — forces 3 columns, dropping layout to 2 rows
- `.menu-content` changed from `overflow-y: auto` → `overflow: hidden` — scroll fully disabled; content clips if it ever exceeds the viewport

With current 7 sections (Rolls + Paleo stacked = 6 grid cells), the 3×2 layout fits comfortably within the available `~84vh` of menu area.

---

## 2026-08-11 — Session with Gabe

### `94da05a` — All menu text switched to Neutraface
All elements previously using `--font-ui` (Inter) inside the menu content area updated to `--font-display` (Neutraface 2 Display):
- `.item-name`
- `.item-price`
- `.item-sold-out-label`
- `.variation-name`
- `.variation-price`
- `.variation-sold-out-label`
- `.footer-location`
- `.footer-updated`

Section headers (`.section-name`) and the loading state were already on Neutraface.

---

### `0a2399c` — Removed left padding from `.menu-content`
Set `padding: var(--pad-y) 0` on `.menu-content` (previously `var(--pad-y) 0 var(--pad-y) var(--pad-x)`).  
Sections now sit flush with the left screen edge — no horizontal outer gap.

---

### `4dc22dd` — Removed right padding from `.menu-content`
Removed `padding-right: var(--pad-x)` from `.menu-content`.  
Sections are now flush with the left edge of the promo image panel.

---

## Earlier — Pre-session commits (chronological)

### `f7fb1fe` — Promo panel: no padding, transparent bg, cover fill, 36vw
`.promo-panel` set to `padding: 0`, transparent background, `object-fit: cover`.  
Image fills the full right panel edge-to-edge.

### `9c3ac9a` — Scale to 4122×2315px (300ppi print resolution)
Viewport meta changed to `width=1920`. Added `html { font-size: 0.8333vw }` so `rem` units scale proportionally at any 16:9 resolution.

### `5b72cdd` — Max image size: top-align flush with categories, remove excess padding
Promo panel changed from `align-items: center` to `align-items: flex-start`.  
Padding changed to `var(--pad-y) 0 0 0`. Added `object-position: top center` to `.promo-img`.

### `6d2760f` — Enlarge promo sidebar by 25% (26vw → 32.5vw)
`.promo-panel` width increased from `26vw` to `32.5vw`.

### `d06a033` — Swap promo to vertical image; stack Paleo below Rolls
Promo image swapped to a vertical format. Paleo section stacked below Rolls in a `.section-stack` column.

### `eb3558c` — Add "Build Your Own Box" promo sidebar (Option B layout)
Introduced the two-panel layout:
- `.menu-root` changed to `display: flex; flex-direction: row`
- `.menu-content` (left, scrollable sections)
- `.promo-panel` (right, `26vw`, promo image)
- `.section-stack` added for stacking multiple sections in one column

### `b7e5eea` — Fix: preserve `rlkey` param in Dropbox URLs
`resolveImageUrl()` in `menu.js` updated to retain the `rlkey` query param when converting `/scl/fi/` Dropbox share links to direct image URLs.

### `fb2fbe7` — Center logo in header, location name on left
Header layout: logo centered (`header-center`), location name left-aligned (`header-left: flex 1`).

### `f1c4423` — Transparent logo PNG, constrained to header height
Logo switched to `logo.png`. Constrained to `calc(var(--header-h) * 0.78)`.

### `408554e` — Item thumbnail images from Google Sheets `image_url`
`buildItemRow()` in `menu.js` checks for `item.image_url`, resolves Dropbox share URLs, and renders a `.item-thumb` element per row.

### `f7599e5` — Add Neutraface 2 Display font
`@font-face` added for `Neutra2Display-Medium.otf`. `--font-display` token introduced. Section headers and display elements switched to Neutraface.

### `71cdb90` — FDB brand color palette
Design tokens introduced: `--pink`, `--plum`, `--teal`, `--off-white`, semantic roles (`--bg`, `--surface`, `--border`, etc.).

---

## Layout Reference

```
┌──────────────────────────────────────────────────────────┐
│  HEADER: location name (left) · logo (center)            │
├──────────────────────────────────────┬───────────────────┤
│  .menu-content (flex: 1)             │  .promo-panel     │
│  padding: var(--pad-y) 0             │  (flex: 0 0 36vw) │
│                                      │  padding: 0       │
│  .sections-grid                      │  object-fit:cover │
│  auto-fill columns @ 22vw min        │                   │
│                                      │  "Build Your Own  │
│  [Section Card] [Section Card] ...   │   Box" image      │
│  [Section Card] [Section Card] ...   │                   │
├──────────────────────────────────────┴───────────────────┤
│  FOOTER: location · last updated                         │
└──────────────────────────────────────────────────────────┘
```

---

## Key Files

| File | Purpose |
|------|---------|
| `public/index.html` | Menu board HTML shell |
| `public/styles.css` | All layout and typography |
| `public/menu.js` | Fetches `output/menu.json`, renders sections, auto-refreshes every 60s |
| `output/menu.json` | Generated display-ready menu data (auto-refreshed every 10 min via cron) |
| `menu_config.json` | Display rules: sections, overrides, sold-out behavior, hidden items |
| `src/buildMenu.js` | Combines Square data + config → `output/menu.json` |
| `src/fetchCatalog.js` | Pulls live catalog from Square API |

---

## Design Tokens (key layout values)

| Token | Value | Role |
|-------|-------|------|
| `--pad-x` | `2vw` | Horizontal padding reference (now unused in menu-content) |
| `--pad-y` | `1.4vh` | Vertical padding |
| `--gap` | `1.4vw` | Grid/stack gap |
| `--header-h` | `9vh` | Header height |
| `--footer-h` | `4.2vh` | Footer height |
| `--font-display` | Neutraface 2 Display → Playfair Display → Georgia | All text |
| `--font-ui` | Inter → system-ui | Connection warning only |
