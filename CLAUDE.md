# Five Daughters Bakery — digital menu displays

Square → Cloud SQL (MySQL) → JSON → GitHub Pages → Fire TV Sticks (Fully Kiosk Browser, reload every 10 min).

**These repos are public.** Never commit secrets, PINs, passwords or tokens. Secrets live in
`~/.openclaw/secrets/` on the Mac mini and, after the migration, in Secret Manager.

## Stores

| Store | Slug | Square location | Layout | Screens |
|---|---|---|---|---|
| The Factory | `the-factory` | ECE7YC9G73NXK | portrait | pastry |
| 5th & Broadway | `5th-broad` | L862ACB6EPKVT | portrait | pastry |
| The Gulch | `the-gulch` | L4CQJADFVPZC9 | horizontal | pastry · carousel · beverages |
| Medley | `medley` | LDR9H5M3GQKXF | horizontal | pastry · carousel · beverages |

The single source for this table in code is `src/lib/locations.js`.

## Repos (owner `jwal7000`, push as `gabenewt`)

| Repo | Serves | Pages source |
|---|---|---|
| menu-display-horizontal | `?loc=the-gulch`, `?loc=medley` pastry; also holds all build code | **`gh-pages` branch**. The main-branch "Deploy to GitHub Pages" workflow is disabled on purpose (it collided with the gh-pages deploy). |
| menu-display-portrait | `?loc=the-factory`, `?loc=5th-broad` | Actions workflow on `main` (copies `output/data` → `public/data`). **Moving to a `gh-pages` branch** (HANDOFF C8); until the Pages source is switched, the workflow is still what's live. |
| menu-display-beverages | bev screens + `admin.html` (staff override app) | Actions workflow on `main` |

Display code changes to the horizontal site must land on **`gh-pages`**, which is what's live. `main`'s `public/` is currently behind it. After C8, the same goes for portrait: display code lands on portrait `gh-pages`, copied to `main:public/` in the same change.

## Pipeline

- **Pastry:** AppSheet → MySQL `FlavorSchedule` → `src/buildMenuFromDB.js` → `{slug}.json`. Sold out when Square inventory ≤ 3.
- **Beverages:** `bev-items-config.json`, curated by hand → `src/buildBeverageMenu.js` → `bev-{slug}.json`. The Square catalog isn't used because espresso items live in Square Restaurants (TAG).
- **Inventory:** every 2 min, Square counts → `src/patchMenuInventory.js` patches the `sold_out` flags.
- **Staff overrides:** `admin.html` writes `public/pastry-overrides-{slug}.json` (this repo, `main`) and `public/overrides-{slug}.json` (beverages repo). The displays read them at runtime. Its item lists come from `main:public/data/{slug}.json` here and `output/bev-items-config.json` in the beverages repo; `menu-build` keeps both current (HANDOFF C7).
- **Today (since cutover, 2026-11-11):** Cloud Run Jobs in `analytics-link-370416` publish everything: `menu-build` (10 min, commits as `menu-build[bot]`) and `inventory-sync` (2 min, `inventory-sync[bot]`), both tagged `[cloud-run]`. Redeploy from the Mac mini with `cloudrun/deploy-menu-jobs.sh jobs` (it keeps the jobs live). The Mac mini at Jonathan's office (Tailscale) still holds the deploy key and the rollback record; its `com.fivedaughters.menu-refresh` job is stopped. `com.fivedaughters.menu-display-portrait`, a leftover local server nothing used, was stopped on 2026-11-12 (plist in `~/Library/LaunchAgents.disabled/`). See `cloudrun/HANDOFF.md`.
- **Portrait v2 (pilot: The Factory):** `menu-display-portrait` `public/v2/`. Pastry on top plus a rotating panel: drinks (`bev-{slug}.json`), seasonal promos from Dropbox (`src/buildPromos.js`, off until the `dropbox-credentials` secret exists) and staff picks (`admin.html` Staff picks tab → `main:public/staff-picks-{slug}.json` here). See `cloudrun/README.md` → "Dropbox promos".
- **Carousel (the Gulch, Medley):** new page `gh-pages` `carousel/?loc={slug}` (1920×1080): Dropbox carousel photos (`/Digital Media/FDB Screen Carousel`, subfolders included) with a promo or the staff picks after every two photos. `menu-build` publishes `data/carousel.json` + `carousel-photos/` and `data/promos-{slug}.json` + `promos/` to `gh-pages` (`src/buildPromos.js`). The old `fdb-carousel` Cloud Run service (code only on the Mac mini, deploy with `deploy-carousel.sh`) stays up until both Fire Sticks are switched; pointing a stick back at it is the rollback.

## Ground rules

- Don't change the Mac mini's launchd jobs or scripts by hand. Use `cloudrun/deploy-menu-jobs.sh` (`cutover` / `rollback`).
- **Mac mini access:** `ssh openclaw-user@100.111.170.29` (Tailscale, from Gabriel's iMac with his key). Do Mac mini work over SSH rather than writing commands for Jonathan. Read-only checks are fine; **ask the user before any command that deploys, changes GCP or touches launchd.** `cutover` and `rollback` still go through Jonathan, at the desktop or over Screen Sharing, never over SSH.
- Get confirmation from the user before pushing to `main` or `gh-pages`, deploying anything to GCP, or running `cutover`. A bad push is on store screens within 10 minutes.
- Only the deploy script talks to GCP, using the `menu-deploy-bot` key. Don't use personal gcloud logins.
- `npm test` must pass before any push.

## Current work

The Mac mini jobs moved to Cloud Run (cut over 2026-11-11). See `cloudrun/HANDOFF.md` for loose ends, and `cloudrun/README.md` for the runbook.
