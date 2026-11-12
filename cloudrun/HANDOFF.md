# Cloud Run migration — handoff (2026-11-05)

Handed over from a claude.ai session. That session couldn't push to GitHub, couldn't reach the npm registry, and couldn't reach the Mac mini. So everything below that needs one of those is still open.

## Where things stand

**Done, merged to `main`** (PR #1, 2026-11-05):
- Two Cloud Run Jobs from one image: `menu-build` (10 min) and `inventory-sync` (2 min). Entrypoint `src/jobs/run.js`; publishing in `src/jobs/publish.js` + `targets.js`.
- Secrets from env vars (Secret Manager: `square-access-token`, `mysql-password`, `github-menu-token`), falling back to the Mac mini's files. Cloud SQL through `MYSQL_SOCKET`. Bev config from `BEV_CONFIG_URL=gs://analytics-link-370416-menu/bev-items-config.json`.
- Fixes:
  - Single-size items carry `variation_id`, so the 2-min sync can match them.
  - The 2-min sync patches `gh-pages` too.
  - The 2-min sync honors `skipInventory` (no store uses it since Medley's inventory went live, see C4).
  - Writes happen only when a `sold_out` flag changes.
  - Inventory is fetched only for the menu's own items.
  - The beverages repo gets both `public/data` and `output/data`.
- `Dockerfile`, `cloudrun/deploy-menu-jobs.sh`, `cloudrun/README.md`, tests (`npm test`, 12 passing, with SDKs stubbed).
- **Cut over on 2026-11-11 at about 09:10 CT.** Cloud Run is the live pipeline. The Mac mini's `menu-refresh` job is stopped (rollback can restore it, see B). Verified on GitHub: only `[cloud-run]` commits since 09:16, no `menu-refresh[bot]` commit after 09:06, and all Pages deploys green.

**The 2-min sold-out sync went live for the first time at cutover.** Before that, the Mac mini only had `com.fivedaughters.menu-refresh` loaded (`com.fivedaughters.inventory-sync` wasn't, and there were no "update sold_out flags" commits back to at least Oct 11), so `sold_out` changed only on the 10-min build. Now items can flip to sold out within about 2 minutes, and screens change more often during the day. That's expected, not a bug.

Mac mini findings from 2026-11-05 (still true after cutover):
- **`com.fivedaughters.menu-display-portrait` is a leftover local web server. No action at cutover.** The portrait Fire Sticks load from GitHub Pages, not from the Mac mini, and the job doesn't publish menu data, so there's no double-publishing risk. Cutover and rollback don't touch it. Stop it when the Mac mini is retired (see C6).
- **Node.** The launchd jobs use `/opt/homebrew/opt/node@22/bin`. Run any manual checks with that Node and as `openclaw-user`. Under `jwal`, Homebrew's `node@22` won't start (permission denied on `openssl@3/libcrypto`). The jobs no longer need it, so it can be fixed any time.
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

### B. Deploy (✅ cut over 2026-11-11, about 09:10 CT)
Prerequisites: Jonathan re-authenticates, and grants `menu-deploy-bot` `roles/cloudscheduler.admin`, `roles/secretmanager.admin` and `roles/cloudsql.client`. Run `preflight` first. It may also flag Cloud Build / Artifact Registry access and storage access on the bucket. It doesn't check `iam.serviceAccountUser` on itself: if that's missing, `jobs` fails with an `iam.serviceaccounts.actAs` error.

The sequence that was run, on the Mac mini from `square-digital-menu-poc` after `git pull` (kept for reference):
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
**Reaching the Mac mini (since 2026-11-12):** `ssh openclaw-user@100.111.170.29` over Tailscale works from Gabriel's iMac with his key. Do Mac mini work over SSH yourself instead of writing commands for Jonathan. Rules:
- Read-only checks (git log/status, logs, `launchctl list`, `preflight`, `compare`) are fine without asking.
- **Ask Gabriel before any command that deploys, changes GCP or touches launchd.** That includes `git pull` right before a deploy, `jobs`, `secrets`, `bev-config`, `schedule`, `resume`, `pause`, `run`, and any `launchctl load`/`unload`/`bootout`/`bootstrap`.
- **`cutover` and `rollback` still go through Jonathan,** at the desktop or over Screen Sharing, never over SSH.
- **Run the deploy script through a login shell.** A non-interactive SSH session gets only `/usr/bin:/bin:/usr/sbin:/sbin`, so `gcloud` (Homebrew) isn't found and the script fails with "Could not activate menu-deploy-bot…" before changing anything. Use `ssh openclaw-user@100.111.170.29 "zsh -lc 'cd ~/.openclaw/workspace/square-digital-menu-poc && cloudrun/deploy-menu-jobs.sh <command>'"`. For ad-hoc read-only `gcloud` calls, also set `CLOUDSDK_CONFIG=~/.openclaw/gcloud-menu-deploy` and `CLOUDSDK_CORE_PROJECT=analytics-link-370416`.

**First dry-run deploy (2026-11-06), what we found:**
- **`jobs` stopped at the image build.** `gcloud builds submit` exited non-zero because `menu-deploy-bot` can't stream logs from the default Cloud Build logs bucket, and `set -e` stopped the script before either job was deployed. `--suppress-logs` didn't help: gcloud still tried to stream and failed the same way. Fixed: `jobs` submits with `--async --format='value(id)'`, prints the build's Cloud Console link, and polls `gcloud builds describe` every 5 s. It continues on `SUCCESS`, stops on `FAILURE` / `TIMEOUT` / `CANCELLED` / `INTERNAL_ERROR` / `EXPIRED`, and gives up after 20 min. Rerun `jobs` after `git pull`.
- **`preflight` misreported the bucket as DENIED.** `gcloud storage ls` has no `--limit` flag. Fixed: it does a plain listing now. Failed probes also print gcloud's first error line, so a bad flag no longer looks like a denial. The actAs line is informational only.
- **`square-access-token` already existed** before our `secrets` run. `secrets` added **version 2** with the Mac mini's token. `put_secret` only adds a version when `latest` doesn't match that token, so either version 1 held a different value, or `menu-deploy-bot` couldn't read it. ✅ Closed 2026-11-12: Jonathan confirmed only the menu pipeline reads `square-access-token`. Nothing else uses it, and version 1 can be disabled.
- **`gs://analytics-link-370416-menu/bev-items-config.json` already existed** before our first `bev-config` upload, so it predates the migration. The jobs read this object, so:
  - confirm it matches the Mac mini's `output/bev-items-config.json`. `compare` after `run menu-build` shows any bev differences. ✅ 2026-11-09: 0 differences.
  - find out what wrote the earlier copy. ✅ Closed 2026-11-12: Jonathan confirmed it was a one-time manual upload, and nothing writes the object.

**Dry-run results (2026-11-09):**
- `jobs` built the image (async build + polling) and deployed both jobs in dry-run.
- `run menu-build` and `run inventory-sync` both completed in Cloud Run. `inventory-sync` ran with `square-access-token` version 2, so that version is a working token.
- `compare`: **0 differences** against what's live on GitHub. The only "?" was the beverages repo's `output/data/bev-medley.json`, which doesn't exist there yet. That's expected: the new code writes bev files to both `public/data` and `output/data`, so cutover creates it.
- Jonathan started the one-day scheduled soak (`schedule` + `resume`, still dry-run) on 2026-11-09.

**Soak: `inventory-sync` timing (2026-11-10).** All executions succeeded, but they took 55 s to 2 min 15 s end to end, so some overlapped the next 2-min trigger. Changes (deployed 2026-11-12, see "Deploys on 2026-11-12" below):
- **Task timeout 110 s → 300 s.** Overlapping runs are tolerated, and a timeout would just lose the run. Cloud Run's end-to-end time also includes its own container startup, which isn't counted against the task timeout.
- **Startup trimmed.** `run.js` imports only the job it runs, and the publisher loads `gcs.js` only for dry-run uploads. A live `inventory-sync` now loads only `square`, not `googleapis` + auth libraries + `mysql2`. Locally, start-up to first work went from 4.2–10.9 s to 1.6–4.9 s.
- **Timing in the logs.** `⏱ … modules loaded at Ns`, `⏱ … finished at Ns`, and `[publish] <target>: Ns` per target. Compare these with the execution's total time in Cloud Run: whatever's left over is Cloud Run's own container startup, which the code can't change.

Not done yet, depending on what the timing logs show:
- **Overlap caveat.** A push that loses a race re-clones and re-applies the Square counts fetched at the *start* of that run. If a slow run pushes after a newer one, it can briefly write older `sold_out` flags; the next run corrects them within 2 min. Fix if it matters: refetch counts on a retry, or when they're older than ~30 s.
- **Drop the Square SDK from `inventory-sync`.** It's the remaining slow import (2.7–7.5 s cold here). Its one endpoint (batch-retrieve inventory counts, with cursor paging) could be a plain `fetch`.
- **Publish the three targets in parallel.** About 1–3 s per clone today; the counts cache would need to become promise-based so the Gulch counts are still fetched once.

**Rollback check (2026-11-09).** I ran `cutover` → `rollback` end to end on today's `main`, with a fake `launchctl` and `gcloud`, starting from today's Mac mini state: `menu-refresh` and `menu-display-portrait` loaded, `inventory-sync` not loaded.
- Cutover recorded only `com.fivedaughters.menu-refresh` and stopped only that job.
- Rollback reloaded only `menu-refresh`, then printed "inventory-sync wasn't loaded at cutover — left off". `inventory-sync` was never loaded, and `menu-display-portrait` was never touched.

Two failure cases to know about:
- **Cutover can't see the jobs.** For example, it's run as the wrong user (`jwal` instead of `openclaw-user`). Before the guard, it recorded `(none)`, stopped nothing, and still switched Cloud Run to live. **Now guarded:** before the CUTOVER prompt, `cutover` checks that `com.fivedaughters.menu-refresh` is loaded. If it isn't, it stops and says to run as `openclaw-user`, and nothing is changed. A rerun after a partial cutover still works, because the record shows the earlier run stopped the job. If it somehow happens anyway, run `rollback` right away.
- **The Scheduler pause fails during rollback** (GCP error, or the key won't authenticate). Rollback stops before reaching launchd, so `menu-refresh` isn't reloaded. The record is kept, so rerun `rollback` once GCP answers. Cloud Run is still publishing in that case, so the screens stay current. If Cloud Run is also publishing bad data, run `launchctl load ~/Library/LaunchAgents/com.fivedaughters.menu-refresh.plist` as `openclaw-user`, and stop the Cloud Run triggers some other way, so you don't have two writers.

**Cutover (2026-11-11, about 09:10 CT).** ✅ Verified on GitHub: only `[cloud-run]` commits (`menu-build[bot]`, `inventory-sync[bot]`) since 09:16, no `menu-refresh[bot]` commit after 09:06, and all Pages deploys green. If a `menu-refresh[bot]` commit, or a data commit without `[cloud-run]`, ever shows up again, the Mac mini is publishing too: check launchd, or roll back.

**Incident: no publishing from 2026-11-11 16:01 CT to 2026-11-12 about 09:57 CT.**
- **What happened:** at about 16:04 CT on 2026-11-11, `jobs` was run from a Mac mini checkout older than the mode fix below. That version deployed in dry-run unless told otherwise, so it put both live jobs back in dry-run. The Mac mini's own job had been stopped at cutover, so nothing published and nothing reported an error. The last data commit before it is `menu-build[bot]` at 16:01 CT. The screens kept showing the 16:01 menus and sold-out flags overnight and into the morning.
- **Restore:** Jonathan ran `DRY_RUN=0 cloudrun/deploy-menu-jobs.sh jobs` at about 09:57 CT on 2026-11-12, **without `git pull` first**. Publishing resumed right away (first data commit: `inventory-sync[bot]` at 09:58 CT, then `menu-build[bot]` at 10:01 CT, on `main` and `gh-pages`). The jobs were live again, but on image `9fd491688`: the pre-fix code, with the old deploy settings (110 s `inventory-sync` timeout), until the 12:28 CT deploy below.
- **Fix:** the mode fix below, on `main` since 2026-11-12 (`9655984d2`). Longer term, auto-deploy (`cloudrun/AUTO-DEPLOY.md`) removes manual deploys from stale checkouts.
- **Lesson:** always `git pull` before `jobs`, and check that the deploy prints the mode you expect.

**Deploys on 2026-11-12.** The jobs now run the fixed code, live. Images by commit, from Artifact Registry and the `inventory-sync` execution history (times CT):
- **about 09:57** `9fd491688` (image built 09:55): Jonathan's restore after the incident (`DRY_RUN=0`, pre-fix code, 110 s timeout).
- **12:28** `c75b24ae3`: a manual `git pull` + `cloudrun/deploy-menu-jobs.sh jobs` in an `openclaw-user` session on the Mac mini (desktop or Screen Sharing; who isn't recorded). Evidence: the checkout's reflog shows `pull: Fast-forward` to `c75b24ae3` at 12:27:53, the image tagged `c75b24ae3` was created at 12:28:42, and the shell history ends with `git pull` then `jobs`. It wasn't a scheduled run: Cloud Run's scheduled executions never build images, the `com.fivedaughters.menu-refresh` job is still stopped since cutover, and `com.fivedaughters.refresh` is a separate job (`~/fdb-qbo/refresh.sh`) that doesn't touch the menu checkout. `c75b24ae3` is just the `menu-build[bot]` data commit the checkout was on at the time. This is the first deploy with the mode fix, the 300 s timeout and lighter startup, and Medley tracking. Medley's first sold-out flags followed at 12:31 (`inventory-sync[bot]`, `52aec78f0`); 14 of 38 Medley items showed sold out.
- **13:07** `1efd249c5`: Claude over SSH, after `git pull`, with Gabriel's OK. Same code as 12:28 plus docs. `jobs` printed `menu-build is currently: live`, `inventory-sync is currently: live`, `keeping DRY_RUN=0 (LIVE …)`. Build `9398baae-210f-4873-aaeb-536c70394a07` took 66 s. Checked after: `inventory-sync` runs with a 300 s timeout, the 13:10 `menu-build` and `inventory-sync` executions succeeded, and `menu-build[bot]` published at 13:11 (`dec95a2a9`).

**Redeploying from now on.** On the Mac mini, as `openclaw-user`: `git pull`, then `cloudrun/deploy-menu-jobs.sh jobs` (over SSH: through `zsh -lc`, see "Reaching the Mac mini"). It should print `keeping DRY_RUN=0 (LIVE …)`. Every `jobs` deploy goes straight to the live screens.

**Fixed 2026-11-11: `jobs` used to switch live jobs back to dry-run.** It defaulted to `DRY_RUN=1`, so a plain `jobs` after cutover would have stopped all publishing without an error: the Mac mini is off, and the screens would have gone stale. Now `jobs` reads each deployed job's `DRY_RUN` and keeps it: live after cutover, dry-run after rollback, dry-run for a first deploy. If the two jobs disagree, or their mode can't be read, it stops before building and asks for `DRY_RUN=0` or `DRY_RUN=1`. Setting `DRY_RUN` explicitly still forces a mode. **Don't run `jobs` from a checkout older than this fix.**

**Deploy questions, closed 2026-11-12** (confirmed by Jonathan):
- **`square-access-token`:** only the menu pipeline reads it. Version 1 can be disabled; version 2 is the one in use.
- **`bev-items-config.json` in GCS:** the earlier copy was a one-time manual upload, and nothing else writes the object. The curated config in GCS is the only copy that matters.

### C. Loose ends
1. **Sync horizontal `main` `public/` with `gh-pages`.** ✅ Done 2026-11-05: `menu.js` and `styles.css` were copied from `gh-pages` ("Build Your Own Boxes" highlight, "Five Daughters Bakery:" title prefix). Rechecked 2026-11-11: `menu.js`, `styles.css` and `index.html` are byte-identical on both. The only file differences are intended: `.nojekyll` exists only on `gh-pages`, and `public/pastry-overrides-*.json` only on `main` (`admin.html` writes there). Display code changes still land on `gh-pages` first; copy them to `main` in the same change.
2. **Retire the legacy bev overrides.** ✅ The read is removed from `buildBeverageMenu.js`. On 2026-11-05, `gs://analytics-link-370416-menu/bev-overrides.json` held `"unavailable": []` (`updated_at: null`, last modified 2026-09-29), so nothing was in effect, and old vs new builds give identical bev output. Staff overrides now come only from `admin.html` → `overrides-{slug}.json`. ✅ Closed 2026-11-12: Jonathan confirmed the `fdb-bev-override` Cloud Run service is unused, and it will be deleted. Nothing reads `bev-overrides.json` any more either, so it can go with the service.
3. **Update the context notes.** Staff and the saved context say to edit the bev config by pushing to the repo. After cutover it's edited in GCS (see `cloudrun/README.md` → "Day to day"). Update them.
4. **Medley inventory.** ✅ Square inventory is live at Medley: on 2026-11-11 all 34 Medley menu variations had current `IN_STOCK` counts. `skipInventory` is removed from Medley in `src/lib/locations.js`. **Live since the 12:28 CT deploy on 2026-11-12**: Medley items with a count of 3 or less show as sold out, on both the 10-min build and the 2-min sync.
5. **Optional, to reduce deploy churn.** `menu-build` commits every run because `generated_at` changes. Consider skipping the push when nothing but timestamps changed. That cuts Pages deploys from about 430 a day, which helps given GitHub Pages' build limits and today's deploy collisions. If you do it, make sure the displays don't use `generated_at` as a freshness check first.
6. **When the Mac mini is retired, stop `com.fivedaughters.menu-display-portrait`.** It's a leftover local server that nothing depends on: the portrait Fire Sticks load from GitHub Pages. It isn't part of cutover, so `deploy-menu-jobs.sh` doesn't manage it. Stop it by hand as `openclaw-user` at retirement.

## Known context from 2026-11-05

- Jonathan was getting a flood of GitHub "Run failed" emails. Cause: on every refresh, the main-branch Actions deploy and the gh-pages branch build raced each other for the horizontal Pages site, and the two published different code. Fixed by disabling the "Deploy to GitHub Pages" workflow in menu-display-horizontal.
- Portrait and beverages had a few GitHub-side Pages failures (500s, timeouts) the same morning, and they recovered on their own.
