#!/usr/bin/env bash
# Avoid tracing input even if the script was started with bash -x.
set +x
set +a
set -euo pipefail
umask 077

die() { printf 'Setup stopped: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 0 ]] || die "Run bash worker/setup.sh from the repository."
command -v node >/dev/null && command -v npx >/dev/null || die "Install Node.js 24+ (with npm) first."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 24 ? 1 : 0)' ||
  die "Install Node.js 24 or later."
[[ -t 0 ]] || die "Run in an interactive terminal so credentials can be entered privately."
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp -- "$here/index.mjs" "$here/wrangler.jsonc" "$stage/"
cp -R -- "$here/migrations" "$stage/"
cd -- "$stage"

printf '%s\n' "Stream Scrobbler: set up D1 and deploy to the existing stream-scrobbler Worker." \
  "No Cloudflare OAuth, Access changes, or Firefox publishing."
if [[ -z ${CLOUDFLARE_ACCOUNT_ID:-} ]]; then
  IFS= read -r -p 'Cloudflare account ID: ' CLOUDFLARE_ACCOUNT_ID || die "Account ID not provided."
fi
[[ $CLOUDFLARE_ACCOUNT_ID =~ ^[[:xdigit:]]{32}$ ]] || die "Expected a 32-character Cloudflare account ID."
if [[ -z ${CLOUDFLARE_API_TOKEN:-} ]]; then
  IFS= read -r -s -p 'Scoped Cloudflare API token (hidden): ' CLOUDFLARE_API_TOKEN || die "Token not provided."
  printf '\n' >&2
fi
[[ -n $CLOUDFLARE_API_TOKEN ]] || die "A scoped token is required. See worker/README.md."
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
export WRANGLER_SEND_METRICS=false CI=true
wrangler() { npx --yes wrangler@latest "$@" </dev/null; }

printf '%s\n' 'Checking access to the existing Worker and D1…'
wrangler secret list --name stream-scrobbler --format json > existing.json ||
  die "Cannot inspect the existing Worker. Check the account and Individual Workers → Editor permission."
missing=$(node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const existing = JSON.parse(readFileSync("existing.json","utf8"));
  if (!Array.isArray(existing) || existing.some(s=>typeof s?.name!=="string"))
    throw new Error("Unexpected Wrangler secret-list response");
  const config = JSON.parse(readFileSync("wrangler.jsonc","utf8"));
  console.log(config.secrets.required.filter(name=>!existing.some(s=>s.name===name)).join(" "));
') || die "Cannot safely determine which Worker secrets exist."

IFS= read -r -p 'Confirm All traffic Access is enabled on this Worker, then type deploy: ' confirmation ||
  die "No confirmation received."
[[ $confirmation == deploy ]] || die "No remote resources changed."

find_db() {
  wrangler d1 list --json | node --input-type=module -e '
    import {readFileSync} from "node:fs";
    const rows = JSON.parse(readFileSync(0,"utf8"));
    if (!Array.isArray(rows) || rows.some(r=>typeof r?.name!=="string")) throw new Error("Unexpected D1 list response");
    const matches = rows.filter(r=>r.name==="stream-scrobbler");
    if (matches.length > 1) throw new Error("Multiple D1 databases named stream-scrobbler");
    if (matches.length) {
      const {uuid} = matches[0];
      if (typeof uuid!=="string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uuid))
        throw new Error("Invalid D1 UUID");
      console.log(uuid);
    }
  '
}

db_id=$(find_db) || die "Cannot list D1 databases. Check D1 → Edit permission."
existing_db=$db_id
unset LASTFM_API_KEY LASTFM_SHARED_SECRET SESSION_ENCRYPTION_KEY
LASTFM_API_KEY=''
LASTFM_SHARED_SECRET=''
SESSION_ENCRYPTION_KEY=''
for name in $missing; do
  case "$name" in
    LASTFM_API_KEY|LASTFM_SHARED_SECRET)
      IFS= read -r -s -p "$name (from the same Last.fm application, hidden): " "$name" ||
        die "Last.fm credential not provided."
      printf '\n' >&2
      [[ -n ${!name} ]] || die "$name cannot be empty."
      ;;
    SESSION_ENCRYPTION_KEY)
      SESSION_ENCRYPTION_KEY=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')
      ;;
    *) die "Unexpected required secret name." ;;
  esac
done

if [[ -z $db_id ]]; then
  wrangler d1 create stream-scrobbler --update-config=false
  db_id=$(find_db)
  [[ -n $db_id ]] || die "Database created but not found in the list. Rerun setup; do not create it manually."
else
  printf 'Reusing D1 database stream-scrobbler.\n'
fi
node --input-type=module - "$db_id" <<'JS'
import {readFileSync,writeFileSync} from "node:fs";
const path="wrangler.jsonc", cfg=JSON.parse(readFileSync(path,"utf8"));
cfg.d1_databases[0].database_id=process.argv[2];
writeFileSync(path, JSON.stringify(cfg,null,2)+"\n");
JS
wrangler d1 migrations apply DB --remote --force

if [[ -n $existing_db && -n $SESSION_ENCRYPTION_KEY ]]; then
  wrangler d1 execute DB --remote --json --command 'SELECT EXISTS(SELECT 1 FROM sessions) AS has_sessions' |
    node --input-type=module -e '
      import {readFileSync} from "node:fs";
      const result = JSON.parse(readFileSync(0,"utf8"));
      if (result?.[0]?.results?.[0]?.has_sessions !== 0) process.exit(1);
    ' || die "Cannot safely generate a new encryption key for this database. If sessions exist, restore the original Worker secret first."
fi

args=(deploy --keep-vars)
if [[ -n $missing ]]; then
  # Pipe values to Node, not argv. The private temporary directory is removed on exit.
  printf '%s\0' "$LASTFM_API_KEY" "$LASTFM_SHARED_SECRET" "$SESSION_ENCRYPTION_KEY" |
    node --input-type=module -e '
      import {readFileSync,writeFileSync} from "node:fs";
      const values=readFileSync(0,"utf8").split("\0");
      const names=["LASTFM_API_KEY","LASTFM_SHARED_SECRET","SESSION_ENCRYPTION_KEY"];
      const payload=Object.fromEntries(names.map((name,i)=>[name,values[i]]).filter(([,value])=>value));
      writeFileSync("secrets.json",JSON.stringify(payload),{mode:0o600,flag:"wx"});
    '
  args+=(--secrets-file "$stage/secrets.json")
fi
unset LASTFM_API_KEY LASTFM_SHARED_SECRET SESSION_ENCRYPTION_KEY
wrangler "${args[@]}"
printf '%s\n' 'Deployment finished. Open the following in your browser and sign in through Cloudflare Access:' \
  '  https://stream-scrobbler.murtaza2142.workers.dev/health' \
  'Expected: {"ok":true}. This checks reachability, not Last.fm sign-in or scrobbling.'
