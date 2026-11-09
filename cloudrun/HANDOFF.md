# Cloud Run migration — handoff (2026-11-05)

Handed over from a claude.ai session. That session couldn't push to GitHub, couldn't reach the npm registry, and couldn't reach the Mac mini. So everything below that needs one of those is still open.

## Where things stand

**Done, merged to `main`** (PR #1, 2026-11-05):
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
- **Deployed in dry-run (2026-11-09)**, and a one-day scheduled soak is running. The Mac mini is still the live pipeline. Not cut over yet: see B → "Before cutover".

**The 2-min sold-out sync isn't live today. Cloud Run's `inventory-sync` will be the first time it runs.** As of 2026-11-05, the Mac mini (user `openclaw-user`) has only `com.fivedaughters.menu-refresh` loaded. `com.fivedaughters.inventory-sync` isn't loaded, and there are no "update sold_out flags" commits back to at least Oct 11. So today, `sold_out` changes only on the 10-min build. After cutover, items can flip to sold out within about 2 minutes, and screens will change more often during the day. Tell the stores before cutover, and expect `inventory-sync[bot]` commits (tagged `[cloud-run]`) to be new.

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

### B. Deploy (dry-run deployed 2026-11-09; soak running; cutover pending)
Prerequisites: Jonathan re-authenticates, and grants `menu-deploy-bot` `roles/cloudscheduler.admin`, `roles/secretmanager.admin` and `roles/cloudsql.client`. Run `preflight` first. It may also flag Cloud Build / Artifact Registry access and storage access on the bucket. It doesn't check `iam.serviceAccountUser` on itself: if that's missing, `jobs` fails with an `iam.serviceaccounts.actAs` error.

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

**First dry-run deploy (2026-11-06), what we found:**
- **`jobs` stopped at the image build.** `gcloud builds submit` exited non-zero because `menu-deploy-bot` can't stream logs from the default Cloud Build logs bucket, and `set -e` stopped the script before either job was deployed. `--suppress-logs` didn't help: gcloud still tried to stream and failed the same way. Fixed: `jobs` submits with `--async --format='value(id)'`, prints the build's Cloud Console link, and polls `gcloud builds describe` every 5 s. It continues on `SUCCESS`, stops on `FAILURE` / `TIMEOUT` / `CANCELLED` / `INTERNAL_ERROR` / `EXPIRED`, and gives up after 20 min. Rerun `jobs` after `git pull`.
- **`preflight` misreported the bucket as DENIED.** `gcloud storage ls` has no `--limit` flag. Fixed: it does a plain listing now. Failed probes also print gcloud's first error line, so a bad flag no longer looks like a denial. The actAs line is informational only.
- **`square-access-token` already existed** before our `secrets` run. `secrets` added **version 2** with the Mac mini's token. `put_secret` only adds a version when `latest` doesn't match that token, so either version 1 held a different value, or `menu-deploy-bot` couldn't read it. Whoever created the secret (another service?) may read `square-access-token:latest`, and now gets version 2. Before cutover, find out who created it and what reads it. Don't disable or destroy version 1 until that's known.
- **`gs://analytics-link-370416-menu/bev-items-config.json` already existed** before our first `bev-config` upload, so it predates the migration. The jobs read this object, so before cutover:
  - confirm it matches the Mac mini's `output/bev-items-config.json`. `compare` after `run menu-build` shows any bev differences. ✅ 2026-11-09: 0 differences.
  - find out what wrote the earlier copy. If something still writes it, it could overwrite the curated config after cutover.

**Dry-run results (2026-11-09):**
- `jobs` built the image (async build + polling) and deployed both jobs in dry-run.
- `run menu-build` and `run inventory-sync` both completed in Cloud Run. `inventory-sync` ran with `square-access-token` version 2, so that version is a working token.
- `compare`: **0 differences** against what's live on GitHub. The only "?" was the beverages repo's `output/data/bev-medley.json`, which doesn't exist there yet. That's expected: the new code writes bev files to both `public/data` and `output/data`, so cutover creates it.
- Jonathan started the one-day scheduled soak (`schedule` + `resume`, still dry-run) on 2026-11-09.

**Rollback check (2026-11-09).** I ran `cutover` → `rollback` end to end on today's `main`, with a fake `launchctl` and `gcloud`, starting from today's Mac mini state: `menu-refresh` and `menu-display-portrait` loaded, `inventory-sync` not loaded.
- Cutover recorded only `com.fivedaughters.menu-refresh` and stopped only that job.
- Rollback reloaded only `menu-refresh`, then printed "inventory-sync wasn't loaded at cutover — left off". `inventory-sync` was never loaded, and `menu-display-portrait` was never touched.

Two failure cases to know about:
- **Cutover can't see the jobs.** For example, it's run as the wrong user (`jwal` instead of `openclaw-user`). Before the guard, it recorded `(none)`, stopped nothing, and still switched Cloud Run to live. **Now guarded:** before the CUTOVER prompt, `cutover` checks that `com.fivedaughters.menu-refresh` is loaded. If it isn't, it stops and says to run as `openclaw-user`, and nothing is changed. A rerun after a partial cutover still works, because the record shows the earlier run stopped the job. If it somehow happens anyway, run `rollback` right away.
- **The Scheduler pause fails during rollback** (GCP error, or the key won't authenticate). Rollback stops before reaching launchd, so `menu-refresh` isn't reloaded. The record is kept, so rerun `rollback` once GCP answers. Cloud Run is still publishing in that case, so the screens stay current. If Cloud Run is also publishing bad data, run `launchctl load ~/Library/LaunchAgents/com.fivedaughters.menu-refresh.plist` as `openclaw-user`, and stop the Cloud Run triggers some other way, so you don't have two writers.

**Before cutover:**
1. **Soak.** Check a day of `menu-build` / `inventory-sync` executions in Cloud Run for failures, then run `compare` again.
2. **`square-access-token`.** Find out who created it and what else reads `:latest` (see above). Still open.
3. **`bev-items-config.json` in GCS.** Find out what wrote the earlier copy, and make sure nothing still writes it. Still open.
4. **Tell the stores** that sold-out items will start updating within about 2 min (see "Where things stand").
5. **Redeploy the jobs from the latest `main`.** The soak's jobs were deployed before the `menu-build[bot]` / `[cloud-run]` change, so they still commit as `menu-refresh[bot]`. On the Mac mini: `git pull`, then `cloudrun/deploy-menu-jobs.sh jobs` (still dry-run), `run menu-build`, and `compare`.
6. **Run cutover as `openclaw-user` on the Mac mini.** The guard refuses to start if it can't see `com.fivedaughters.menu-refresh`. In cutover's output, the "recorded loaded jobs" list should show `com.fivedaughters.menu-refresh`.

After cutover:
- Check a screen at each store. Expect sold-out items to update within about 2 min. That's new behavior (see above), not a bug.
- Watch Cloud Run executions for an hour.
- Confirm the data commits are now `menu-build[bot]` ("auto-refresh menu data [cloud-run] [HH:MM]") and `inventory-sync[bot]` ("update sold_out flags [cloud-run] [HH:MM]"). Any new `menu-refresh[bot]` commit, or a data commit without `[cloud-run]`, means the Mac mini is still publishing: check launchd, or roll back.

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
