# Cloud Run migration — handoff (2026-11-05)

Handed over from a claude.ai session. That session couldn't push to GitHub, couldn't reach the npm registry, and couldn't reach the Mac mini. So everything below that needs one of those is still open.

## Where things stand

**Done, on branch `cloud-run-jobs`** (pushed; PR #1 against `main`, not merged):
- Two Cloud Run Jobs from one image: `menu-build` (10 min) and `inventory-sync` (2 min). Entrypoint `src/jobs/run.js`; publishing in `src/jobs/publish.js` + `targets.js`.
- Secrets from env vars (Secret Manager: `square-access-token`, `mysql-password`, `github-menu-token`), falling back to the Mac mini's files. Cloud SQL through `MYSQL_SOCKET`. Bev config from `BEV_CONFIG_URL=gs://analytics-link-370416-menu/bev-items-config.json`.
- Fixes:
  - Single-size items carry `variation_id`, so the 2-min sync can match them.
  - The 2-min sync patches `gh-pages` too.
  - The 2-min sync honors `skipInventory`.
  - Writes happen only when a `sold_out` flag changes.
  - Inventory is fetched only for the menu's own items.
  - The beverages repo gets both `public/data` and `output/data`.
- `Dockerfile`, `cloudrun/deploy-menu-jobs.sh`, `cloudrun/README.md`, tests (`npm test`, 12 passing, with SDKs stubbed).
- Nothing deployed. The Mac mini is still the live pipeline.

**The 2-min sold-out sync isn't live today. Cloud Run's `inventory-sync` will be the first time it runs.** As of 2026-11-05, the Mac mini (user `openclaw-user`) has only `com.fivedaughters.menu-refresh` loaded. `com.fivedaughters.inventory-sync` isn't loaded, and there are no "update sold_out flags" commits back to at least Oct 11. So today, `sold_out` changes only on the 10-min build. After cutover, items can flip to sold out within about 2 minutes, and screens will change more often during the day. Tell the stores before cutover, and expect `inventory-sync[bot]` commits to be new.

Other Mac mini findings from 2026-11-05:
- **`com.fivedaughters.menu-display-portrait` is a leftover local web server. No action at cutover.** The portrait Fire Sticks load from GitHub Pages, not from the Mac mini, and the job doesn't publish menu data, so there's no double-publishing risk. Cutover and rollback don't touch it. Stop it when the Mac mini is retired (see C6).
- **Node.** The launchd jobs use `/opt/homebrew/opt/node@22/bin`. Run any manual checks with that Node and as `openclaw-user`. Under `jwal`, Homebrew's `node@22` won't start (permission denied on `openssl@3/libcrypto`). Leave that alone until after cutover.
- **Rollback.** `cutover` records which launchd jobs were loaded (`~/.openclaw/menu-cutover-launchd.txt`), and `rollback` reloads only those, so it won't switch on `inventory-sync`.

**Decisions already made:**
- `bev-items-config.json` moves to GCS bucket `analytics-link-370416-menu`. It isn't kept in a repo.
- The jobs use the existing GitHub token, stored as Secret Manager secret `github-menu-token`.
- `menu-deploy-bot@analytics-link-370416.iam.gserviceaccount.com` is both deployer and runtime identity.
- The Mac mini runs the deploy script, the same way as `deploy-carousel.sh`.
- The horizontal site is served from `gh-pages`. The main-branch Pages workflow stays disabled.

## Tasks

Work in order, and confirm with the user before every push, GCP change or cutover.

### A. Land the branch
1. ✅ Pushed `cloud-run-jobs`; PR #1 against `main`.
2. ✅ `npm install` and `npm test` (12 passing).
3. ✅ **Square SDK pagination.** square@44.2.0 follows `cursor` across pages and maps fields to camelCase (checked with a stubbed `fetch`). Live Gulch counts read through the Square connector match the published `sold_out` flags. The API also returns `RETURNED_BY_CUSTOMER` / `WASTE` counts, and the code correctly keeps only `IN_STOCK`.
4. ⏭ `docker build .` skipped: Cloud Build builds the image at deploy time (user's call).
5. **Before merging:** run the branch for real on the Mac mini in a throwaway clone (`npm ci`, `build-menu-db`, `build-bev`, then diff against the live `output/data`, ignoring `generated_at` / `inventory_patched_at`). Expected difference: the new `variation_id`. Run it as `openclaw-user` with `NODE_DIR=/opt/homebrew/opt/node@22/bin`. The first attempt ran as `jwal` and stopped at `npm ci` (see Node above).
6. Merge after the user approves the diff. It's safe to merge before cutover: the Mac mini scripts work unchanged on this code.

### B. Deploy (blocked on Jonathan)
Prerequisites: Jonathan re-authenticates, and grants `menu-deploy-bot` `roles/cloudscheduler.admin`, `roles/secretmanager.admin` and `roles/cloudsql.client`. Run `preflight` first, and expect it may also flag `iam.serviceAccountUser` on itself, Cloud Build / Artifact Registry access, and storage access on the bucket.

On the Mac mini, from `square-digital-menu-poc` after `git pull`:
```
cloudrun/deploy-menu-jobs.sh preflight
cloudrun/deploy-menu-jobs.sh secrets
cloudrun/deploy-menu-jobs.sh bev-config
cloudrun/deploy-menu-jobs.sh jobs          # dry-run
cloudrun/deploy-menu-jobs.sh run menu-build
cloudrun/deploy-menu-jobs.sh run inventory-sync
cloudrun/deploy-menu-jobs.sh compare
cloudrun/deploy-menu-jobs.sh schedule && cloudrun/deploy-menu-jobs.sh resume   # optional 1-day soak, still dry-run
cloudrun/deploy-menu-jobs.sh cutover
```
Reaching the Mac mini: SSH over Tailscale from the user's Mac, if Remote Login or Tailscale SSH is enabled. Otherwise hand the commands to the user or Jonathan.

After cutover:
- Check a screen at each store. Expect sold-out items to update within about 2 min. That's new behavior (see above), not a bug.
- Watch Cloud Run executions for an hour.
- Confirm only `menu-refresh[bot]` / `inventory-sync[bot]` commits appear.

### C. Loose ends (can go in parallel with B)
1. **Sync horizontal `main` `public/` with `gh-pages`.** `gh-pages` has the newer `menu.js` and `styles.css` ("Build Your Own Boxes" highlight, "Five Daughters Bakery:" title prefix). Copy them back to `main/public/` so the two don't drift. Keep `public/pastry-overrides-*.json` on `main`, because `admin.html` writes there.
2. **Retire the legacy bev overrides.** ✅ The read is removed from `buildBeverageMenu.js`. On 2026-11-05, `gs://analytics-link-370416-menu/bev-overrides.json` held `"unavailable": []` (`updated_at: null`, last modified 2026-09-29), so nothing was in effect, and old vs new builds give identical bev output. Staff overrides now come only from `admin.html` → `overrides-{slug}.json`. **Still open:** ask Jonathan before deprecating the `fdb-bev-override` Cloud Run service and deleting the file. Nothing reads it any more.
3. **Update the context notes.** Staff and the saved context say to edit the bev config by pushing to the repo. After cutover it's edited in GCS (see `cloudrun/README.md` → "Day to day"). Update them.
4. **Medley inventory.** Once Square inventory is set up there, remove `skipInventory` in `src/lib/locations.js` and redeploy the jobs.
5. **Optional, to reduce deploy churn.** `menu-build` commits every run because `generated_at` changes. Consider skipping the push when nothing but timestamps changed. That cuts Pages deploys from about 430 a day, which helps given GitHub Pages' build limits and today's deploy collisions. If you do it, make sure the displays don't use `generated_at` as a freshness check first.
6. **When the Mac mini is retired, stop `com.fivedaughters.menu-display-portrait`.** It's a leftover local server that nothing depends on: the portrait Fire Sticks load from GitHub Pages. It isn't part of cutover, so `deploy-menu-jobs.sh` doesn't manage it. Stop it by hand as `openclaw-user` at retirement.

## Known context from 2026-11-05

- Jonathan was getting a flood of GitHub "Run failed" emails. Cause: on every refresh, the main-branch Actions deploy and the gh-pages branch build raced each other for the horizontal Pages site, and the two published different code. Fixed by disabling the "Deploy to GitHub Pages" workflow in menu-display-horizontal.
- Portrait and beverages had a few GitHub-side Pages failures (500s, timeouts) the same morning, and they recovered on their own.
