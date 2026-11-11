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
#   cloudrun/deploy-menu-jobs.sh jobs              # build image + deploy both jobs, keeping their live/dry-run mode
#   cloudrun/deploy-menu-jobs.sh schedule          # create/update Scheduler triggers (created PAUSED)
#   cloudrun/deploy-menu-jobs.sh run <job>         # run a job once now and wait
#   cloudrun/deploy-menu-jobs.sh compare           # diff latest dry-run output against what's live on GitHub
#   cloudrun/deploy-menu-jobs.sh cutover           # LIVE: record + stop Mac mini launchd jobs, jobs push for real, resume Scheduler
#   cloudrun/deploy-menu-jobs.sh rollback          # pause Scheduler, reload only the launchd jobs cutover recorded
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
LAUNCHD_LABELS="com.fivedaughters.menu-refresh com.fivedaughters.inventory-sync"   # the jobs cutover may stop
# Which of LAUNCHD_LABELS were loaded at cutover, so rollback restores exactly that.
# Kept outside the repo (it's public and gets git-pulled).
LAUNCHD_STATE_FILE="${LAUNCHD_STATE_FILE:-$HOME/.openclaw/menu-cutover-launchd.txt}"

JOBS="menu-build inventory-sync"
SCHEDULE_menu_build="*/10 * * * *"
SCHEDULE_inventory_sync="*/2 * * * *"
TIMEOUT_menu_build="600s"
# Runs take ~1–2.5 min end to end in the soak, so they can overlap the next 2-min trigger.
# Overlap is tolerated (pushes retry from a fresh clone); a timeout would just lose the run.
TIMEOUT_inventory_sync="300s"
BUILD_POLL_SECS="${BUILD_POLL_SECS:-5}"         # how often jobs checks the Cloud Build status
BUILD_TIMEOUT_SECS="${BUILD_TIMEOUT_SECS:-1200}" # give up waiting after 20 min

# Unset: `jobs` keeps whatever mode the deployed jobs are in (live after cutover, dry-run
# after rollback), and dry-run for a first deploy. DRY_RUN=1 / DRY_RUN=0 forces a mode.
DRY_RUN="${DRY_RUN:-}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── gcloud with the service account, isolated from personal config ───────────
export CLOUDSDK_CONFIG="${CLOUDSDK_CONFIG_DIR:-$HOME/.openclaw/gcloud-menu-deploy}"
export CLOUDSDK_CORE_PROJECT="$PROJECT"
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

log()  { printf '\033[1m▶︎ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
info() { printf '  \033[36mi\033[0m %s\n' "$*"; }
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
  # On failure, show gcloud's first error line: a bad flag and a real denial look alike otherwise.
  probe() {
    local err
    if err="$(eval "$2" 2>&1 >/dev/null)"; then ok "$1"
    else warn "$1 — FAILED: $(printf '%s\n' "$err" | grep -m1 -v '^[[:space:]]*$' || echo 'no error output')"; fi
  }
  probe "Cloud Run jobs (run.admin)"            "gcloud run jobs list --region $REGION --limit 1"
  probe "Cloud Scheduler (cloudscheduler.admin)" "gcloud scheduler jobs list --location $REGION --limit 1"
  probe "Secret Manager (secretmanager.admin)"   "gcloud secrets list --limit 1"
  probe "Cloud Build (cloudbuild.builds.editor)" "gcloud builds list --region $REGION --limit 1"
  probe "Artifact Registry repo $AR_REPO"        "gcloud artifacts repositories describe $AR_REPO --location $REGION"
  probe "Cloud SQL instance visible"             "gcloud sql instances describe ${SQL_INSTANCE##*:}"
  # gcloud storage ls has no --limit; a plain top-level listing is the read probe.
  probe "Bucket gs://$BUCKET"                    "gcloud storage ls gs://$BUCKET"
  # Not probed: reading the SA's IAM policy needs a different permission than actAs, so it misreports.
  info "actAs $RUNTIME_SA (iam.serviceAccountUser) — not checkable here; if missing, 'jobs' fails with iam.serviceaccounts.actAs"
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
# Prints the DRY_RUN value a deployed job runs with, "none" if the job doesn't exist yet.
# Fails if the job exists but can't be read.
deployed_dry_run() {
  local job="$1" json
  if ! json="$(gcloud run jobs describe "$job" --region "$REGION" --format=json 2>/dev/null)"; then
    gcloud run jobs list --region "$REGION" --format='value(metadata.name)' 2>/dev/null | grep -qx "$job" \
      && return 1   # exists, but describe failed
    echo none; return 0
  fi
  python3 -c '
import json, sys
c = json.load(sys.stdin)["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]
print(next((e.get("value", "") for e in c.get("env", []) if e.get("name") == "DRY_RUN"), "1"))' <<<"$json"
}

# Decide the mode for `jobs`. Redeploying must never flip live jobs back to dry-run by
# accident (screens would silently stop updating) or put dry-run jobs live.
resolve_dry_run() {
  if [[ -n "$DRY_RUN" ]]; then
    [[ "$DRY_RUN" == 0 || "$DRY_RUN" == 1 ]] || die "DRY_RUN must be 0 or 1 (got '$DRY_RUN')."
    info "DRY_RUN=$DRY_RUN set explicitly"; return
  fi
  local job mode modes=""
  for job in $JOBS; do
    mode="$(deployed_dry_run "$job")" \
      || die "Couldn't read $job's current mode. Rerun with DRY_RUN=0 (live) or DRY_RUN=1 (dry-run). Nothing was deployed."
    info "$job is currently: $([[ $mode == 0 ]] && echo live || { [[ $mode == none ]] && echo 'not deployed' || echo dry-run; })"
    [[ "$mode" == none ]] || modes="$modes $mode"
  done
  case "$modes" in
    "")              DRY_RUN=1 ;;   # first deploy
    *0*1*|*1*0*)     die "The jobs are in different modes (DRY_RUN:$modes). Rerun with DRY_RUN=0 or DRY_RUN=1. Nothing was deployed." ;;
    " 0"|" 0 0")     DRY_RUN=0 ;;
    " 1"|" 1 1")     DRY_RUN=1 ;;
    *)               die "Unexpected DRY_RUN on the deployed jobs ($modes). Rerun with DRY_RUN=0 or DRY_RUN=1. Nothing was deployed." ;;
  esac
  info "keeping DRY_RUN=$DRY_RUN ($([[ $DRY_RUN == 0 ]] && echo 'LIVE: these jobs push to the screens' || echo dry-run))"
}

cmd_jobs() {
  log "Checking the jobs' current mode"
  resolve_dry_run
  local tag image
  tag="$(git -C "$REPO_ROOT" rev-parse --short HEAD)$(git -C "$REPO_ROOT" diff --quiet || echo -dirty)"
  image="$IMAGE_BASE:$tag"

  log "Building $image (Cloud Build)"
  # Submit with --async and poll the status ourselves. Waiting on the build makes gcloud
  # stream logs, and menu-deploy-bot can't read the default logs bucket
  # ("can only stream logs if you are Viewer/Owner"). --suppress-logs didn't avoid that.
  local build_id link status last="" fails=0 start=$SECONDS
  build_id="$(gcloud builds submit "$REPO_ROOT" --region "$REGION" --tag "$image" \
                --async --format='value(id)' --quiet)" || die "Cloud Build submit failed (see gcloud's error above)."
  [[ "$build_id" =~ ^[0-9a-f-]{36}$ ]] || die "Cloud Build submit didn't return a build ID (got: '$build_id')."
  link="https://console.cloud.google.com/cloud-build/builds;region=$REGION/$build_id?project=$PROJECT"
  info "build $build_id — logs: $link"

  while :; do
    if status="$(gcloud builds describe "$build_id" --region "$REGION" --format='value(status)' 2>/dev/null)"; then
      fails=0
    else
      fails=$((fails + 1))
      # Three failed describes in a row: a permission problem, not a network blip.
      [[ $fails -lt 3 ]] || die "Can't read the build status (gcloud builds describe failed 3× in a row). Logs: $link"
      status="$last"
    fi
    [[ "$status" == "$last" ]] || { info "build status: $status"; last="$status"; }
    case "$status" in
      SUCCESS) break ;;
      FAILURE|TIMEOUT|CANCELLED|INTERNAL_ERROR|EXPIRED)
        die "Cloud Build $status — no jobs deployed. Logs: $link" ;;
    esac
    (( SECONDS - start < BUILD_TIMEOUT_SECS )) \
      || die "Gave up after $((BUILD_TIMEOUT_SECS / 60)) min (last status: ${status:-unknown}); no jobs deployed. The build may still be running. Logs: $link"
    sleep "$BUILD_POLL_SECS"
  done
  ok "image built ($(( SECONDS - start ))s)"

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
# Exact label match on launchctl's 3rd column. Captured first, not piped into
# grep -q, so pipefail can't turn an early grep exit into "not loaded".
launchd_loaded() {
  local labels
  labels="$(launchctl list 2>/dev/null | awk 'NR > 1 { print $3 }')"
  printf '%s\n' "$labels" | grep -qxF "$1"
}

# Writes the loaded subset of LAUNCHD_LABELS to the state file. Never overwrites
# an existing record: a second cutover would see nothing loaded and record that.
launchd_record() {
  if [[ -f "$LAUNCHD_STATE_FILE" ]]; then
    warn "keeping existing record from the first cutover: $LAUNCHD_STATE_FILE"
    sed 's/^/      /' "$LAUNCHD_STATE_FILE"
    return
  fi
  mkdir -p "$(dirname "$LAUNCHD_STATE_FILE")"
  {
    echo "# launchd jobs loaded at cutover, $(date '+%Y-%m-%d %H:%M:%S %Z'). rollback reloads only these."
    for label in $LAUNCHD_LABELS; do
      if launchd_loaded "$label"; then echo "$label"; fi
    done
  } > "$LAUNCHD_STATE_FILE"
  ok "recorded loaded jobs in $LAUNCHD_STATE_FILE:"
  grep -v '^#' "$LAUNCHD_STATE_FILE" | sed 's/^/      /' || echo "      (none)"
}

launchd_stop() {
  for label in $LAUNCHD_LABELS; do
    if launchd_loaded "$label"; then
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || launchctl unload "$LAUNCH_AGENTS_DIR/$label.plist"
      ok "stopped $label"
    else
      ok "$label not loaded — leaving it alone"
    fi
  done
}

# Reloads only the labels cutover recorded. Without a record it reloads nothing:
# guessing could switch on a job that wasn't running before.
launchd_restore() {
  [[ -f "$LAUNCHD_STATE_FILE" ]] || {
    warn "no cutover record at $LAUNCHD_STATE_FILE — not reloading any launchd job."
    warn "Check what should run, then load it by hand: launchctl load $LAUNCH_AGENTS_DIR/<label>.plist"
    return 1
  }
  local label plist failed=0
  for label in $(grep -v '^#' "$LAUNCHD_STATE_FILE"); do
    case " $LAUNCHD_LABELS " in
      *" $label "*) ;;
      *) warn "ignoring unexpected label in record: $label"; continue ;;
    esac
    if launchd_loaded "$label"; then ok "$label already loaded"; continue; fi
    plist="$LAUNCH_AGENTS_DIR/$label.plist"
    [[ -f "$plist" ]] || { warn "missing $plist — start $label by hand"; failed=1; continue; }
    if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist"; then
      ok "reloaded $label"
    else
      warn "could not reload $label"; failed=1
    fi
  done
  for label in $LAUNCHD_LABELS; do
    grep -qxF "$label" "$LAUNCHD_STATE_FILE" || ok "$label wasn't loaded at cutover — left off"
  done
  [[ $failed -eq 0 ]] || return 1
  # Done: archive the record so a later cutover records fresh state.
  mv "$LAUNCHD_STATE_FILE" "$LAUNCHD_STATE_FILE.restored-$(date +%Y%m%d-%H%M%S)"
}

# Refuses to cut over unless this session can see (and so stop) the Mac mini's menu-refresh job.
# Without it, cutover would record "(none)", stop nothing, and leave two pipelines publishing.
# A rerun after a partial cutover is allowed: the record shows we already stopped it.
CUTOVER_REQUIRED_LABEL="com.fivedaughters.menu-refresh"
cutover_guard() {
  local req="$CUTOVER_REQUIRED_LABEL"
  if launchd_loaded "$req"; then
    ok "$req is loaded; cutover will record and stop it"
    return
  fi
  if [[ -f "$LAUNCHD_STATE_FILE" ]] && grep -qxF "$req" "$LAUNCHD_STATE_FILE"; then
    ok "$req was already stopped by an earlier cutover ($LAUNCHD_STATE_FILE); continuing"
    return
  fi
  die "$req isn't loaded for user '$(whoami)', so cutover couldn't stop it and the Mac mini would keep
  publishing alongside Cloud Run. Run cutover as openclaw-user on the Mac mini, in a session where
  'launchctl list | grep fivedaughters' shows $req. Nothing was changed."
}

cmd_cutover() {
  log "Checking the Mac mini's launchd jobs"
  cutover_guard
  echo "This makes Cloud Run the live pipeline: the Mac mini launchd jobs stop and"
  echo "the Cloud Run jobs start pushing to GitHub. Rollback: $0 rollback"
  read -r -p "Type CUTOVER to continue: " answer
  [[ "$answer" == "CUTOVER" ]] || die "Aborted."

  log "Recording which Mac mini launchd jobs are loaded (rollback restores exactly these)"
  launchd_record
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
  log "Reloading the Mac mini launchd jobs that were loaded at cutover"
  launchd_restore || die "Rollback incomplete: Cloud Run is paused and in dry-run, but launchd needs a hand (see above)."
}

# ── main ──────────────────────────────────────────────────────────────────────
cmd="${1:-}"; shift || true
case "$cmd" in
  preflight|secrets|jobs|schedule|resume|pause|run|compare|cutover|rollback) auth; "cmd_$cmd" "$@" ;;
  bev-config) auth; cmd_bev_config "$@" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
