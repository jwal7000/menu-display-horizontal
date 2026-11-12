# Auto-deploy for the menu jobs — design (draft, 2026-11-12)

For Gabriel and Jonathan. Nothing here is built yet.

## Why

Today a code change reaches Cloud Run only when someone runs `git pull` and `cloudrun/deploy-menu-jobs.sh jobs` on the Mac mini. That has two problems:

- **Code on `main` and code in Cloud Run drift apart.** Fixes sit merged but not deployed until someone remembers.
- **A manual deploy from an old checkout can break the screens.** On 2026-11-11 a `jobs` run from a checkout older than the mode fix put both live jobs back in dry-run. Nothing published after 16:01 CT, and the screens went stale overnight.

Goal: **when code on `main` changes, rebuild the image and redeploy both jobs automatically, in the mode they're already in. Never deploy for data commits.**

## What counts as a code change

Deploy when a push to `main` changes any of:

```
src/**
package.json
package-lock.json
Dockerfile
.dockerignore
cloudrun/deploy-menu-jobs.sh
```

Never deploy for:

- **Data commits:** `output/data/**`, written by `menu-build[bot]` and `inventory-sync[bot]` (`[cloud-run]`) up to ~30 times an hour.
- **Staff overrides:** `public/pastry-overrides-*.json`, written by `admin.html`.
- **Display code:** `public/**` and anything on `gh-pages`. The screens load these straight from Pages; they aren't in the job image.
- **Docs:** `*.md`, `cloudrun/*.md`.
- **Pushes to `gh-pages`.** Only `main` is watched.

The path filter alone keeps data commits out. As a second guard, the workflow also skips a push when every commit in it is by a `*[bot]` author. So if a bot ever touches a code path by mistake, it can't deploy its own change.

## Recommended: GitHub Actions + Workload Identity Federation, calling the existing script

A workflow in `menu-display-horizontal` (`.github/workflows/deploy-menu-jobs.yml`):

1. **Trigger:** `push` to `main` with the path filter above, plus `workflow_dispatch` (manual run, optional `ref` input for redeploying an older commit).
2. **Test:** `npm ci && npm test`. Stop if it fails, so nothing is deployed.
3. **Authenticate to GCP** with `google-github-actions/auth` through Workload Identity Federation, impersonating the deploy service account. No key is stored in GitHub.
4. **Deploy:** `cloudrun/deploy-menu-jobs.sh jobs`, with `DRY_RUN` **unset**, so the script keeps each job's current mode (live stays live, dry-run stays dry-run, and it refuses if they disagree or can't be read).
5. **Check:** wait for the next scheduled `inventory-sync` execution (≤ 2 min) and fail the workflow if it didn't succeed. GitHub emails the pusher on failure.

Settings:

- `concurrency: { group: deploy-menu-jobs, cancel-in-progress: false }`, so two quick merges deploy one after the other, never at once.
- `permissions: { contents: read, id-token: write }`.
- `timeout-minutes: 30` (the script's own Cloud Build wait gives up at 20).

### Why this over a Cloud Build trigger

| | GitHub Actions + WIF | Cloud Build trigger |
|---|---|---|
| Reuses `deploy-menu-jobs.sh` (mode keeping, build polling) | Yes, as is | Only if the build step shells out to it; otherwise the logic is duplicated in `cloudbuild.yaml` |
| Path filters | Native (`paths:`) | Native (`includedFiles`) |
| Setup | WIF pool + provider in GCP; workflow file in the repo | GitHub App connection to `jwal7000`'s repo (repo owner must install it) + trigger |
| Where you see results | The repo's Actions tab, next to the commits | Cloud Console; `menu-deploy-bot` can't read the default build logs bucket today |
| Failure notice | GitHub email to the pusher | Needs Pub/Sub or a separate alert |
| Tests before deploy | Same job | Extra build step |

Either works. Actions keeps one deploy path (the script) and puts results where we already look.

## Changes needed

**In the repo (small):**

- `deploy-menu-jobs.sh` `auth()`: skip the key-file activation when the environment already has credentials (e.g. `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` set by `google-github-actions/auth`). The Mac mini keeps using the key file.
- `cmd_jobs`: tag images with the full commit SHA (it already uses the short SHA), so any deploy can be traced to a commit and an older image can be redeployed.
- The new workflow file.
- `CLAUDE.md` ground rule: "Only the deploy script talks to GCP, using the `menu-deploy-bot` key" becomes "Only the deploy script talks to GCP: from the Mac mini with the `menu-deploy-bot` key, or from the auto-deploy workflow via WIF."

**In GCP (Jonathan, needs IAM admin):**

- A Workload Identity pool and GitHub OIDC provider, with an attribute condition that accepts only `assertion.repository == "jwal7000/menu-display-horizontal"` **and** `assertion.ref == "refs/heads/main"` **and** `assertion.event_name in ["push", "workflow_dispatch"]`. The repo is public, so this is what stops forks and pull requests from ever getting GCP credentials.
- `roles/iam.workloadIdentityUser` on the deploy service account for that provider's principal set.
- Decide which service account (see open questions).

## Safety

- **Mode never changes automatically.** The workflow never sets `DRY_RUN`. Cutover and rollback stay manual, on the Mac mini, because they also touch launchd there.
- **Rollback of a bad deploy:** run the workflow manually with the previous good commit as `ref`, or revert the commit on `main` (which deploys the revert). The Mac mini `jobs` command keeps working as a fallback.
- **Rollback of the whole migration** (`deploy-menu-jobs.sh rollback`) is unchanged.
- **Tests gate every deploy.** `npm test` must pass, same rule as for pushes.
- **Who can deploy:** anyone who can push to `main` (today Gabriel and Jonathan). Branch protection requiring a PR review would also gate deploys; that's a separate decision, and the bots push to `main` too, so they'd need an exception.

## Open questions

1. **Service account:** reuse `menu-deploy-bot` (also the jobs' runtime identity, with `secretmanager.admin`), or create a narrower `menu-ci-deployer` that can only build and deploy (Cloud Build editor, Artifact Registry writer, `run.developer`, `actAs` on the runtime account)? Narrower is safer, since the trigger lives on a public repo. Recommendation: the new account.
2. **Who sets up WIF in GCP**, and when?
3. **The `secrets` and `bev-config` commands** stay manual on the Mac mini. Fine?
4. **Retiring the Mac mini:** once auto-deploy works, the Mac mini is only needed for rollback (launchd) and the manual fallback. The deploy key there can stay until it's retired.

## Rollout

1. Jonathan creates the WIF pool, provider and service account.
2. Repo changes land on `main` (the workflow starts with `workflow_dispatch` only, no `push` trigger).
3. Run it by hand once while the jobs are live. It should print `keeping DRY_RUN=0 (LIVE …)` and the next executions should succeed.
4. Add the `push` trigger. Check that a data commit doesn't start it and a `src/` change does.
5. Update `CLAUDE.md` and `cloudrun/README.md`.
