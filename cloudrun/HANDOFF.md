# Cloud Run migration — handoff (2026-11-05)

Handed over from a claude.ai session. That session couldn't push to GitHub, couldn't reach the npm registry, and couldn't reach the Mac mini. So everything below that needs one of those is still open.

## Where things stand

**Done, on branch `cloud-run-jobs`** (not yet pushed; it arrived as a patch file):
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

**Decisions already made:**
- `bev-items-config.json` moves to GCS bucket `analytics-link-370416-menu`. It isn't kept in a repo.
- The jobs use the existing GitHub token, stored as Secret Manager secret `github-menu-token`.
- `menu-deploy-bot@analytics-link-370416.iam.gserviceaccount.com` is both deployer and runtime identity.
- The Mac mini runs the deploy script, the same way as `deploy-carousel.sh`.
- The horizontal site is served from `gh-pages`. The main-branch Pages workflow stays disabled.

## Tasks

Work in order, and confirm with the user before every push, GCP change or cutover.

### A. Land the branch
1. Apply the patch and push `cloud-run-jobs`. Open a PR against `main`.
2. `npm install` and `npm test`.
3. **Verify the Square SDK pagination for real.** `src/lib/square.js` uses `for await (const c of page)` on `client.inventory.batchGetCounts(...)`, and this hasn't been run against the installed SDK (square ^44). Write a throwaway script that calls `fetchInventoryCounts` read-only for one location and a few variation IDs from `output/data/the-gulch.json`. Compare the result with the Square dashboard, or with the Square MCP connector if one is available.
4. `docker build .` to confirm the image builds.
5. Merge after the user approves. It's safe to merge before cutover: the Mac mini scripts work unchanged on this code.

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
- Check a screen at each store.
- Watch Cloud Run executions for an hour.
- Confirm only `menu-refresh[bot]` / `inventory-sync[bot]` commits appear.

### C. Loose ends (can go in parallel with B)
1. **Sync horizontal `main` `public/` with `gh-pages`.** `gh-pages` has the newer `menu.js` and `styles.css` ("Build Your Own Boxes" highlight, "Five Daughters Bakery:" title prefix). Copy them back to `main/public/` so the two don't drift. Keep `public/pastry-overrides-*.json` on `main`, because `admin.html` writes there.
2. **Retire the legacy bev overrides.** `buildBeverageMenu.js` still reads `https://storage.googleapis.com/analytics-link-370416-menu/bev-overrides.json`, written by the old `fdb-bev-override` Cloud Run service. Check that the file holds nothing still in effect. Then remove the read, and ask Jonathan before deprecating the service.
3. **Update the context notes.** Staff and the saved context say to edit the bev config by pushing to the repo. After cutover it's edited in GCS (see `cloudrun/README.md` → "Day to day"). Update them.
4. **Medley inventory.** Once Square inventory is set up there, remove `skipInventory` in `src/lib/locations.js` and redeploy the jobs.
5. **Optional, to reduce deploy churn.** `menu-build` commits every run because `generated_at` changes. Consider skipping the push when nothing but timestamps changed. That cuts Pages deploys from about 430 a day, which helps given GitHub Pages' build limits and today's deploy collisions. If you do it, make sure the displays don't use `generated_at` as a freshness check first.

## Known context from 2026-11-05

- Jonathan was getting a flood of GitHub "Run failed" emails. Cause: on every refresh, the main-branch Actions deploy and the gh-pages branch build raced each other for the horizontal Pages site, and the two published different code. Fixed by disabling the "Deploy to GitHub Pages" workflow in menu-display-horizontal.
- Portrait and beverages had a few GitHub-side Pages failures (500s, timeouts) the same morning, and they recovered on their own.
