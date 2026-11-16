#!/usr/bin/env bash
set -euo pipefail

: "${SUPABASE_URL:?Set SUPABASE_URL in the Render environment.}"
: "${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY in the Render environment.}"

if [[ "$SUPABASE_URL" != https://* ]]; then
  echo "SUPABASE_URL must use HTTPS." >&2
  exit 1
fi

if [[ "$SUPABASE_ANON_KEY" == sb_secret_* ]]; then
  echo "Use a Supabase publishable key, not a secret key." >&2
  exit 1
fi

if [[ "$SUPABASE_ANON_KEY" == eyJ*.*.* ]]; then
  payload="${SUPABASE_ANON_KEY#*.}"
  payload="${payload%%.*}"
  payload="${payload//-/+}"
  payload="${payload//_/\/}"
  case $((${#payload} % 4)) in
    2) payload+="==" ;;
    3) payload+="=" ;;
  esac
  claims="$(printf '%s' "$payload" | base64 --decode 2>/dev/null || true)"
  if [[ ! "$claims" =~ \"role\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    echo "Could not verify the role in the Supabase JWT; provide the anon key." >&2
    exit 1
  fi
  if [[ "${BASH_REMATCH[1]}" != anon ]]; then
    echo "The Supabase JWT must have the anon role. Never publish an authenticated or service-role key." >&2
    exit 1
  fi
fi

if [[ -e dist || -L dist ]]; then
  echo "Refusing to overwrite existing dist/. Remove it before building." >&2
  exit 1
fi

stage="$(mktemp -d ./.passport-desk-build.XXXXXX)"
trap 'rm -rf -- "$stage"' EXIT

cp index.html app.js mrz.mjs styles.css manifest.webmanifest icon.svg "$stage/"
cache_name="passport-desk-shell-$(date -u +%Y%m%d%H%M%S)"
sed -E "s/passport-desk-shell-[^\"]+/${cache_name}/" sw.js > "$stage/sw.js"

js_string() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\r'/\\r}
  value=${value//$'\n'/\\n}
  printf '"%s"' "$value"
}

{
  printf 'window.PDESK_CONFIG = { supabaseUrl: '
  js_string "$SUPABASE_URL"
  printf ', supabaseAnonKey: '
  js_string "$SUPABASE_ANON_KEY"
  printf ' };\n'
} > "$stage/config.js"

mv "$stage" dist
trap - EXIT
