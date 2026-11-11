# Menu pipeline on Cloud Run Jobs

Moves the two Mac mini launchd jobs to Cloud Run so the menus keep updating when the Mac mini is off.

| Cloud Run Job    | Schedule (America/Chicago) | Replaces (Mac mini)     | What it does |
|------------------|----------------------------|-------------------------|--------------|
| `menu-build`     | every 10 min               | `refresh-menu.sh`       | FlavorSchedule (Cloud SQL) + Square → pastry JSON; bev config (GCS) → bev JSON; publish to all repos |
| `inventory-sync` | every 2 min                | `refresh-inventory.sh`  | Square inventory → patch `sold_out` in the published JSON; push only when a flag changes |

Both jobs use one image (`Dockerfile`, entrypoint `src/jobs/run.js <job>`).

## How it works

- **Secrets** come from Secret Manager as env vars: `square-access-token`, `mysql-password`, `github-menu-token`.
- **Database:** Cloud SQL connector socket `/cloudsql/analytics-link-370416:us-central1:fivedaughtersbakery`. On the Mac mini the same code still uses the proxy on `127.0.0.1:3307`.
- **Bev config:** `gs://analytics-link-370416-menu/bev-items-config.json` is now the source of truth. Edit it with `gcloud storage cp` or the Cloud Console. The copy on the Mac mini is no longer read once cutover is done.
- **Publishing:** each run shallow-clones the target branch, writes the files, commits as `menu-build[bot]` / `inventory-sync[bot]` with a `[cloud-run]` tag in the message, and pushes. The Mac mini commits as `menu-refresh[bot]` with no tag, so GitHub shows which pipeline pushed. If the push loses a race, for example with admin.html, it re-clones and tries again (3 attempts). One repo failing doesn't stop the others. The job exits non-zero so the failure shows up in Cloud Run.

| Repo / branch | Files |
|---|---|
| menu-display-horizontal `main` | `output/data/*.json` (all locations + bev) |
| menu-display-horizontal `gh-pages` | `data/*.json` |
| menu-display-portrait `main` | `output/data/the-factory.json`, `5th-broad.json` |
| menu-display-beverages `main` | `public/data/bev-*.json` **and** `output/data/bev-*.json` |

## Fixes included

1. **The 2-min sync matched single-size items by SKU.** It never matched, so only multi-size items were patched. Menus now carry `variation_id` and the patcher matches on it.
2. **The 2-min sync didn't update `gh-pages`.** It now patches `gh-pages` as well as `main`.
3. **The beverages deploy workflow overwrote fresh data with the stale `output/data` copy.** Both copies are now written.
4. **The 2-min sync rewrote `inventory_patched_at` every run**, which made a diff, and so a push, every time. It now writes only when a flag changes.
5. **The 2-min sync checked Medley despite `skipInventory`.** It now honors the flag. (Medley's Square inventory went live on 2026-11-11, so no store sets it any more.)
6. **The inventory fetch paged the entire Square catalog** every run for every store. It now asks only for the variations on that store's menu.

The Mac mini scripts keep working on this code with no changes: secrets fall back to `~/.openclaw/secrets/*`, the bev config falls back to the local file, and no new npm packages were added.

## Deploying (on the Mac mini)

Run these from the repo root after merging. Each step is safe to re-run.

```bash
git pull
cloudrun/deploy-menu-jobs.sh preflight     # APIs + permission probes, changes nothing
```

**Permissions `menu-deploy-bot` needs.** It's both the deployer and the runtime identity. Override the runtime identity with `RUNTIME_SA=` if you want a separate least-privilege account.

| Role | Why | Status |
|---|---|---|
| `roles/cloudscheduler.admin` | create the triggers | to grant |
| `roles/secretmanager.admin` | create the secrets; jobs read them | to grant |
| `roles/cloudsql.client` | jobs connect to MySQL | to grant |
| `roles/run.admin` | deploy the jobs; Scheduler runs them | has (carousel) |
| `roles/iam.serviceAccountUser` on itself | deploy jobs/triggers that run as it | check |
| `roles/cloudbuild.builds.editor` + `roles/artifactregistry.writer` | build the image | check (carousel may already use these) |
| `roles/storage.objectAdmin` on `gs://analytics-link-370416-menu` | read bev config, write dry-run output | check |

```bash
cloudrun/deploy-menu-jobs.sh secrets       # Mac mini secret files → Secret Manager
cloudrun/deploy-menu-jobs.sh bev-config    # one-time: local bev-items-config.json → GCS
cloudrun/deploy-menu-jobs.sh jobs          # build image, deploy both jobs in DRY RUN
cloudrun/deploy-menu-jobs.sh run menu-build
cloudrun/deploy-menu-jobs.sh run inventory-sync
cloudrun/deploy-menu-jobs.sh compare       # dry-run output vs live GitHub, timestamps ignored
```

In dry-run mode the jobs do everything except push. Changed files go to `gs://analytics-link-370416-menu/dry-run/<repo>/<branch>/…` instead. The Mac mini stays live the whole time.

**Expected `compare` differences:** single-size items gain `variation_id`. Sold-out flags may differ if inventory moved between the two runs.

### Soak (optional, recommended for a day)

```bash
cloudrun/deploy-menu-jobs.sh schedule      # creates both triggers PAUSED
cloudrun/deploy-menu-jobs.sh resume        # dry-run jobs on schedule; check Cloud Run logs
```

### Cutover

```bash
cloudrun/deploy-menu-jobs.sh cutover       # asks you to type CUTOVER
```

Run it as `openclaw-user` on the Mac mini. Before the prompt, cutover checks that `com.fivedaughters.menu-refresh` is loaded. If it isn't, cutover stops and changes nothing, because it couldn't stop the Mac mini job and both pipelines would publish. A rerun after a partial cutover is allowed. Cutover then records which of `com.fivedaughters.menu-refresh` and `com.fivedaughters.inventory-sync` are loaded, in `~/.openclaw/menu-cutover-launchd.txt`. Then it stops those jobs, switches the Cloud Run jobs to `DRY_RUN=0`, resumes the triggers, and runs `menu-build` once. After that, check a screen at each store. Running cutover again keeps the first record. Other launchd jobs, such as `com.fivedaughters.menu-display-portrait`, aren't touched.

The 2-min sold-out updates went live for the first time at cutover (2026-11-11). Before that, `inventory-sync` wasn't loaded on the Mac mini, so only the 10-min build set `sold_out`. Now items can flip to sold out within about 2 minutes, so screens change more often during the day.

### Redeploying after cutover

`git pull`, then `cloudrun/deploy-menu-jobs.sh jobs`. `jobs` keeps the deployed jobs' current mode: live after cutover, dry-run after rollback. Check that it prints `keeping DRY_RUN=0 (LIVE …)`. To force a mode, set `DRY_RUN=0` or `DRY_RUN=1`. If the two jobs are in different modes, or their mode can't be read, `jobs` stops before building.

### Rollback

```bash
cloudrun/deploy-menu-jobs.sh rollback      # pause triggers, jobs back to dry-run, reload the recorded launchd jobs
```

Rollback reloads only the jobs in the cutover record, so a job that was off before cutover (today, `inventory-sync`) stays off. When it's done, it renames the record to `….restored-<timestamp>`. If there's no record, it reloads nothing and tells you to load jobs by hand.

## Day to day

| Task | How |
|---|---|
| Change menu items | AppSheet. No change; picked up within 10 min |
| Change beverage items/prices | `gcloud storage cp bev-items-config.json gs://analytics-link-370416-menu/` |
| Deploy a code change | merge to `main`, then `cloudrun/deploy-menu-jobs.sh jobs` |
| Rotate the Square/GitHub token | update the Mac mini secret file, then `cloudrun/deploy-menu-jobs.sh secrets` |
| Logs | Cloud Console → Cloud Run → Jobs → `menu-build` / `inventory-sync` → Executions |

## Local testing

```bash
npm test     # stubs Square/MySQL/GCS; publisher tested against local bare git repos
```
