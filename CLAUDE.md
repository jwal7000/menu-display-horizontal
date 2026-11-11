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
| menu-display-portrait | `?loc=the-factory`, `?loc=5th-broad` | Actions workflow on `main` (copies `output/data` → `public/data`) |
| menu-display-beverages | bev screens + `admin.html` (staff override app) | Actions workflow on `main` |

Display code changes to the horizontal site must land on **`gh-pages`**, which is what's live. `main`'s `public/` is currently behind it.

## Pipeline

- **Pastry:** AppSheet → MySQL `FlavorSchedule` → `src/buildMenuFromDB.js` → `{slug}.json`. Sold out when Square inventory ≤ 3.
- **Beverages:** `bev-items-config.json`, curated by hand → `src/buildBeverageMenu.js` → `bev-{slug}.json`. The Square catalog isn't used because espresso items live in Square Restaurants (TAG).
- **Inventory:** every 2 min, Square counts → `src/patchMenuInventory.js` patches the `sold_out` flags.
- **Staff overrides:** `admin.html` writes `public/pastry-overrides-{slug}.json` (this repo, `main`) and `public/overrides-{slug}.json` (beverages repo). The displays read them at runtime.
- **Today (since cutover, 2026-11-11):** Cloud Run Jobs in `analytics-link-370416` publish everything: `menu-build` (10 min, commits as `menu-build[bot]`) and `inventory-sync` (2 min, `inventory-sync[bot]`), both tagged `[cloud-run]`. Redeploy from the Mac mini with `cloudrun/deploy-menu-jobs.sh jobs` (it keeps the jobs live). The Mac mini at Jonathan's office (Tailscale) still holds the deploy key and the rollback record; its `com.fivedaughters.menu-refresh` job is stopped. `com.fivedaughters.menu-display-portrait` is a leftover local server (the portrait Fire Sticks load from GitHub Pages): stop it when the Mac mini is retired. See `cloudrun/HANDOFF.md`.
- **Carousel:** a separate Cloud Run service (`fdb-carousel`). Deploy with `deploy-carousel.sh` on the Mac mini.

## Ground rules

- Don't change the Mac mini's launchd jobs or scripts by hand. Use `cloudrun/deploy-menu-jobs.sh` (`cutover` / `rollback`).
- Get confirmation from the user before pushing to `main` or `gh-pages`, deploying anything to GCP, or running `cutover`. A bad push is on store screens within 10 minutes.
- Only the deploy script talks to GCP, using the `menu-deploy-bot` key. Don't use personal gcloud logins.
- `npm test` must pass before any push.

## Current work

The Mac mini jobs moved to Cloud Run (cut over 2026-11-11). See `cloudrun/HANDOFF.md` for loose ends, and `cloudrun/README.md` for the runbook.
