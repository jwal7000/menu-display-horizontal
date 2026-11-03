#!/bin/bash
# deploy-menu-jobs.sh — deploy the menu pipeline as Cloud Run Jobs + Cloud Scheduler.
#
# Runs on the Mac mini, like deploy-carousel.sh: authenticates with the
# menu-deploy-bot service account key in an isolated gcloud config, so it never
# depends on (or disturbs) anyone's personal gcloud login.
#
# Usage (from the repo root):
#   cloudrun/deploy-menu-jobs.sh preflight         # check APIs + permissions, change nothing
#   cloudrun/deploy-menu-jobs.sh secrets           # create/refresh Secret Manager secrets from ~/.openclaw/secrets
#   cloudrun/deploy-menu-jobs.sh bev-config [--force]  # upload bev-items-config.json to GCS (one-time move)
#   cloudrun/deploy-menu-jobs.sh jobs              # build image + deploy both jobs (DRY_RUN=1 by default)
#   cloudrun/deploy-menu-jobs.sh schedule          # create/update Scheduler triggers (created PAUSED)
#   cloudrun/deploy-menu-jobs.sh run <job>         # run a job once now and wait
#   cloudrun/deploy-menu-jobs.sh compare           # diff latest dry-run output against what's live on GitHub
#   cloudrun/deploy-menu-jobs.sh cutover           # LIVE: stop Mac mini launchd jobs, jobs push for real, resume Scheduler
#   cloudrun/deploy-menu-jobs.sh rollback          # pause Scheduler, restart Mac mini launchd jobs
#
# Bash 3.2 compatible (macOS default).

set -euo pipefail

# ── Settings ──────────────────────────────────────────────────────────────────
PROJECT="${PROJECT:-analytics-link-370416}"
REGION="${REGION:-us-central1}"
SQL_INSTANCE="${SQL_INSTANCE:-analytics-link-370416:us-central1:fivedaughtersbakery}"
BUCKET="${BUCKET:-analytics-link-370416-menu}"
DEPLOY_SA="${DEPLOY_SA:-menu-deploy-bot@analytics-link-370416.iam.gserviceaccount.com}"
RUNTIME_SA="${RUNTIME_SA:-$DEPLOY_SA}"          # identity the jobs + Scheduler run as
KEY_FILE="${KEY_FILE:-$HOME/.openclaw/secrets/gcp-menu-deploy-sa.json}"
SECRETS_DIR="${SECRETS_DIR:-$HOME/.openclaw/secrets}"
BEV_CONFIG_LOCAL="${BEV_CONFIG_LOCAL:-$HOME/.openclaw/workspace/square-digital-menu-poc/output/bev-items-config.json}"
AR_REPO="${AR_REPO:-cloud-run-source-deploy}"
IMAGE_BASE="$REGION-docker.pkg.dev/$PROJECT/$AR_REPO/menu-jobs"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHD_LABELS="com.fivedaughters.menu-refresh com.fivedaughters.inventory-sync"

JOBS="menu-build inventory-sync"
SCHEDULE_menu_build="*/10 * * * *"
SCHEDULE_inventory_sync="*/2 * * * *"
TIMEOUT_menu_build="600s"
TIMEOUT_inventory_sync="110s"   # must finish before the next 2-min trigger

DRY_RUN="${DRY_RUN:-1}"          # jobs deploy in dry-run unless DRY_RUN=0 (cutover sets it)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── gcloud with the service account, isolated from personal config ───────────
export CLOUDSDK_CONFIG="${CLOUDSDK_CONFIG_DIR:-$HOME/.openclaw/gcloud-menu-deploy}"
export CLOUDSDK_CORE_PROJECT="$PROJECT"
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

log()  { printf '\033[1m▶︎ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

auth() {
  [[ -f "$KEY_FILE" ]] || die "Service account key not found: $KEY_FILE"
  mkdir -p "$CLOUDSDK_CONFIG"
  gcloud auth activate-service-account "$DEPLOY_SA" --key-file="$KEY_FILE" --quiet >/dev/null 2>&1 \
    || die "Could not activate $DEPLOY_SA"
}

json_field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"; }

# ── preflight ─────────────────────────────────────────────────────────────────
cmd_preflight() {
  log "APIs"
  local enabled
  if enabled="$(gcloud services list --enabled --format='value(config.name)' 2>/dev/null)"; then
    for api in run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com \
               cloudbuild.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com; do
      if grep -qx "$api" <<<"$enabled"; then ok "$api"; else warn "$api NOT enabled — gcloud services enable $api"; fi
    done
  else
    warn "Can't list services (needs serviceusage.services.list) — skipping API check"
  fi

  log "Permissions for $DEPLOY_SA (read-only probes)"
  probe() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else warn "$1 — DENIED"; fi; }
  probe "Cloud Run jobs (run.admin)"            "gcloud run jobs list --region $REGION --limit 1"
  probe "Cloud Scheduler (cloudscheduler.admin)" "gcloud scheduler jobs list --location $REGION --limit 1"
  probe "Secret Manager (secretmanager.admin)"   "gcloud secrets list --limit 1"
  probe "Cloud Build (cloudbuild.builds.editor)" "gcloud builds list --region $REGION --limit 1"
  probe "Artifact Registry repo $AR_REPO"        "gcloud artifacts repositories describe $AR_REPO --location $REGION"
  probe "Cloud SQL instance visible"             "gcloud sql instances describe ${SQL_INSTANCE##*:}"
  probe "Bucket gs://$BUCKET"                    "gcloud storage ls gs://$BUCKET --limit 1"
  probe "actAs $RUNTIME_SA (iam.serviceAccountUser)" \
        "gcloud iam service-accounts get-iam-policy $RUNTIME_SA"
  echo
  echo "  Runtime SA ($RUNTIME_SA) also needs: roles/cloudsql.client, roles/secretmanager.secretAccessor,"
  echo "  storage read on gs://$BUCKET (write for dry-run uploads), roles/run.invoker (for Scheduler)."
  echo "  These can't be probed from here — check them in IAM if a job run fails."

  log "Local files"
  for f in "$KEY_FILE" "$SECRETS_DIR/square.json" "$SECRETS_DIR/mysql.env" "$SECRETS_DIR/menu-refresh.json" "$BEV_CONFIG_LOCAL"; do
    if [[ -f "$f" ]]; then ok "$f"; else warn "missing: $f"; fi
  done
}

# ── secrets ───────────────────────────────────────────────────────────────────
# put_secret NAME — value on stdin. Creates the secret, or adds a version only if it changed.
put_secret() {
  local name="$1" value
  value="$(cat)"
  [[ -n "$value" ]] || die "Empty value for secret $name"
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets create "$name" --replication-policy=automatic --data-file=- >/dev/null
    ok "$name created"
  elif [[ "$(gcloud secrets versions access latest --secret="$name" 2>/dev/null)" == "$value" ]]; then
    ok "$name unchanged"
  else
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
    ok "$name updated (new version)"
  fi
}

cmd_secrets() {
  log "Secret Manager"
  json_field "$SECRETS_DIR/square.json" access_token        | put_secret square-access-token
  json_field "$SECRETS_DIR/menu-refresh.json" github_token  | put_secret github-menu-token
  grep '^MYSQL_PASSWORD' "$SECRETS_DIR/mysql.env" | head -1 | cut -d= -f2- | tr -d '\r\n' \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'               | put_secret mysql-password
}

# ── bev config → GCS ──────────────────────────────────────────────────────────
cmd_bev_config() {
  local dest="gs://$BUCKET/bev-items-config.json"
  log "bev-items-config.json → $dest"
  [[ -f "$BEV_CONFIG_LOCAL" ]] || die "Not found: $BEV_CONFIG_LOCAL"
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d.get('sections'), list)" "$BEV_CONFIG_LOCAL" \
    || die "$BEV_CONFIG_LOCAL is not valid bev config JSON"
  if gcloud storage objects describe "$dest" >/dev/null 2>&1 && [[ "${1:-}" != "--force" ]]; then
    warn "$dest already exists — GCS is now the source of truth. Re-run with --force to overwrite it."
    return
  fi
  gcloud storage cp "$BEV_CONFIG_LOCAL" "$dest" --content-type=application/json >/dev/null
  ok "uploaded"
}

# ── jobs ──────────────────────────────────────────────────────────────────────
cmd_jobs() {
  local tag image
  tag="$(git -C "$REPO_ROOT" rev-parse --short HEAD)$(git -C "$REPO_ROOT" diff --quiet || echo -dirty)"
  image="$IMAGE_BASE:$tag"

  log "Building $image (Cloud Build)"
  gcloud builds submit "$REPO_ROOT" --region "$REGION" --tag "$image" --quiet

  local env_vars="MYSQL_SOCKET=/cloudsql/$SQL_INSTANCE,BEV_CONFIG_URL=gs://$BUCKET/bev-items-config.json,DRY_RUN=$DRY_RUN,DRY_RUN_URL=gs://$BUCKET/dry-run"
  local secrets="SQUARE_ACCESS_TOKEN=square-access-token:latest,MYSQL_PASSWORD=mysql-password:latest,GITHUB_TOKEN=github-menu-token:latest"

  for job in $JOBS; do
    local key="${job//-/_}" timeout_var
    timeout_var="TIMEOUT_$key"
    log "Deploying job $job (DRY_RUN=$DRY_RUN)"
    gcloud run jobs deploy "$job" \
      --region "$REGION" \
      --image "$image" \
      --args "$job" \
      --service-account "$RUNTIME_SA" \
      --set-cloudsql-instances "$SQL_INSTANCE" \
      --set-env-vars "$env_vars" \
      --set-secrets "$secrets" \
      --tasks 1 --max-retries 0 \
      --task-timeout "${!timeout_var}" \
      --cpu 1 --memory 512Mi \
      --quiet
    ok "$job deployed"
  done
}

# ── scheduler ─────────────────────────────────────────────────────────────────
cmd_schedule() {
  for job in $JOBS; do
    local key="${job//-/_}" sched_var trigger uri
    sched_var="SCHEDULE_$key"
    trigger="$job-trigger"
    uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$job:run"
    log "Scheduler $trigger (${!sched_var}, America/Chicago)"
    if gcloud scheduler jobs describe "$trigger" --location "$REGION" >/dev/null 2>&1; then
      gcloud scheduler jobs update http "$trigger" --location "$REGION" \
        --schedule "${!sched_var}" --time-zone America/Chicago \
        --uri "$uri" --http-method POST --oauth-service-account-email "$RUNTIME_SA" --quiet >/dev/null
      ok "updated (pause/resume state unchanged)"
    else
      gcloud scheduler jobs create http "$trigger" --location "$REGION" \
        --schedule "${!sched_var}" --time-zone America/Chicago \
        --uri "$uri" --http-method POST --oauth-service-account-email "$RUNTIME_SA" \
        --attempt-deadline 30s --quiet >/dev/null
      gcloud scheduler jobs pause "$trigger" --location "$REGION" --quiet >/dev/null
      ok "created PAUSED — resume with: $0 resume"
    fi
  done
}

scheduler_state() {
  for job in $JOBS; do
    gcloud scheduler jobs "$1" "$job-trigger" --location "$REGION" --quiet >/dev/null
    ok "$job-trigger: $1d"
  done
}
cmd_resume() { log "Resuming Scheduler triggers"; scheduler_state resume; }
cmd_pause()  { log "Pausing Scheduler triggers";  scheduler_state pause; }

cmd_run() {
  local job="${1:-}"; [[ -n "$job" ]] || die "Usage: $0 run <menu-build|inventory-sync>"
  log "Executing $job now"
  gcloud run jobs execute "$job" --region "$REGION" --wait
}

# ── compare dry-run output with what is live ─────────────────────────────────
cmd_compare() {
  log "Comparing gs://$BUCKET/dry-run with GitHub (ignoring timestamps)"
  local tmp; tmp="$(mktemp -d)"
  gcloud storage cp -r "gs://$BUCKET/dry-run/*" "$tmp/" >/dev/null 2>&1 || die "No dry-run output yet — run: $0 run menu-build"
  python3 - "$tmp" <<'PY'
import json, os, sys, urllib.request
root = sys.argv[1]
IGNORE = {"generated_at", "inventory_patched_at"}
def strip(d): return {k: v for k, v in d.items() if k not in IGNORE}
diffs = 0
for dirpath, _, files in os.walk(root):
    for f in files:
        local = os.path.join(dirpath, f)
        repo, branch, *path = os.path.relpath(local, root).split(os.sep)
        url = f"https://raw.githubusercontent.com/jwal7000/{repo}/{branch}/{'/'.join(path)}"
        try:
            live = json.load(urllib.request.urlopen(url, timeout=20))
        except Exception as e:
            print(f"  ? {repo}@{branch}/{'/'.join(path)} — live copy not readable ({e})"); continue
        new = json.load(open(local))
        if strip(new) == strip(live):
            print(f"  ✓ {repo}@{branch}/{'/'.join(path)}")
        else:
            diffs += 1
            print(f"  ✗ {repo}@{branch}/{'/'.join(path)} differs")
            a, b = json.dumps(strip(live), indent=1).splitlines(), json.dumps(strip(new), indent=1).splitlines()
            import difflib
            for line in list(difflib.unified_diff(a, b, "live", "cloud-run", n=1, lineterm=""))[:40]:
                print("      " + line)
print(f"\n  {diffs} file(s) differ. Expected differences: single-size items gain a variation_id field.")
PY
  rm -rf "$tmp"
}

# ── cutover / rollback ────────────────────────────────────────────────────────
launchd_stop() {
  for label in $LAUNCHD_LABELS; do
    if launchctl list | grep -q "$label"; then
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || launchctl unload "$LAUNCH_AGENTS_DIR/$label.plist"
      ok "stopped $label"
    else
      ok "$label not running"
    fi
  done
}
launchd_start() {
  for label in $LAUNCHD_LABELS; do
    local plist="$LAUNCH_AGENTS_DIR/$label.plist"
    [[ -f "$plist" ]] || { warn "missing $plist — start $label by hand"; continue; }
    launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist"
    ok "started $label"
  done
}

cmd_cutover() {
  echo "This makes Cloud Run the live pipeline: the Mac mini launchd jobs stop and"
  echo "the Cloud Run jobs start pushing to GitHub. Rollback: $0 rollback"
  read -r -p "Type CUTOVER to continue: " answer
  [[ "$answer" == "CUTOVER" ]] || die "Aborted."

  log "Stopping Mac mini launchd jobs (so nothing pushes twice)"
  launchd_stop
  log "Switching jobs to live (DRY_RUN=0)"
  for job in $JOBS; do
    gcloud run jobs update "$job" --region "$REGION" --update-env-vars DRY_RUN=0 --quiet >/dev/null
    ok "$job live"
  done
  cmd_resume
  log "Running menu-build once now"
  cmd_run menu-build
}

cmd_rollback() {
  cmd_pause
  log "Switching jobs back to dry-run"
  for job in $JOBS; do
    gcloud run jobs update "$job" --region "$REGION" --update-env-vars DRY_RUN=1 --quiet >/dev/null || true
  done
  log "Restarting Mac mini launchd jobs"
  launchd_start
}

# ── main ──────────────────────────────────────────────────────────────────────
cmd="${1:-}"; shift || true
case "$cmd" in
  preflight|secrets|jobs|schedule|resume|pause|run|compare|cutover|rollback) auth; "cmd_$cmd" "$@" ;;
  bev-config) auth; cmd_bev_config "$@" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
