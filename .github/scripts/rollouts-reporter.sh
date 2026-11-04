#!/bin/sh
# Reports one deploy to Cursor Rollouts. Entry points: bootstrap, start, finish.
# A failure to report names the cause and returns success so the deploy continues.
# The token exchange is stored in RUNNER_TEMP, so the calls in one job exchange once.

rollouts_stopped=0
rollouts_temps=""

rollouts_note() {
  echo "Rollouts reporter: $1" >&2
}

rollouts_error() {
  rollouts_note "$1"
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::error title=Rollouts reporter::$1" >&2
  fi
}

rollouts_halt() {
  rollouts_stopped=1
}

rollouts_cleanup() {
  # shellcheck disable=SC2086
  if [ -n "$rollouts_temps" ]; then
    rm -f $rollouts_temps
  fi
}
trap rollouts_cleanup EXIT

rollouts_new_temp() {
  # $1 is the variable that receives the path. mktemp stays in this shell so
  # the cleanup list is not lost to a command substitution.
  eval "$1=\$(mktemp)"
  eval "rollouts_temps=\"\$rollouts_temps \$$1\""
}

rollouts_state_dir="${RUNNER_TEMP:-/tmp}"
rollouts_state_key="$(printf '%s' "${CHANGE_MONITOR_ENV:-}-${CHANGE_MONITOR_SERVICE:-}" | tr -c 'A-Za-z0-9._-' '_')"
rollouts_state_file="${rollouts_state_dir}/rollouts-${rollouts_state_key}.json"
rollouts_token_cache="${rollouts_state_dir}/rollouts-access-token"

rollouts_unavailable() {
  rollouts_note "Rollouts API unavailable, deploy not reported"
  rollouts_halt
}

rollouts_json() {
  rollouts_var="$1"
  shift
  if ! rollouts_value="$(jq -nc "$@" 2>/dev/null)"; then
    rollouts_note "could not build the ${rollouts_var} request. The deploy was not reported."
    rollouts_halt
    return 1
  fi
  return 0
}

rollouts_exchange() {
  [ "$rollouts_stopped" -eq 1 ] && return 0
  if [ -s "$rollouts_token_cache" ]; then
    TOKEN="$(cat "$rollouts_token_cache")"
    return 0
  fi
  rollouts_new_temp exchange_body
  exchange_status="$(curl -sS --connect-timeout 10 --max-time 20 -o "$exchange_body" -w "%{http_code}" -X POST https://api2.cursor.sh/auth/exchange_user_api_key \
    -H "Authorization: Bearer ${CURSOR_API_KEY}" -H "Content-Type: application/json" -d '{}')" || {
    rollouts_unavailable
    return 0
  }
  case "$exchange_status" in
    401|403)
      rollouts_error "CURSOR_API_KEY was rejected (HTTP ${exchange_status}) by the token exchange. Replace the CURSOR_API_KEY secret with a team API key from https://cursor.com/dashboard/api-keys. A personal key or a key with no team access is rejected. The deploy continues."
      rollouts_halt
      return 0
      ;;
    2*)
      ;;
    *)
      rollouts_unavailable
      return 0
      ;;
  esac
  TOKEN="$(jq -r '.accessToken // empty' "$exchange_body" 2>/dev/null || true)"
  if [ -z "$TOKEN" ]; then
    rollouts_note "the token exchange response did not include an access token. The deploy was not reported."
    rollouts_halt
    return 0
  fi
  printf '%s' "$TOKEN" > "$rollouts_token_cache"
  chmod 600 "$rollouts_token_cache" 2>/dev/null || true
}

rollouts_post() {
  [ "$rollouts_stopped" -eq 1 ] && return 0
  call="$1"
  url="$2"
  body="$3"
  allow409="${4:-}"
  rollouts_new_temp response
  status="$(curl -sS --connect-timeout 10 --max-time 20 -o "$response" -w "%{http_code}" -X POST "$url" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -H "Connect-Protocol-Version: 1" \
    -d "$body")" || {
    rollouts_unavailable
    return 0
  }
  case "$status" in
    401|403)
      rollouts_error "CURSOR_API_KEY was rejected (HTTP ${status}) by ${call}. Replace the CURSOR_API_KEY secret with a team API key from https://cursor.com/dashboard/api-keys. A personal key or a key with no team access is rejected. The deploy continues."
      rollouts_halt
      return 0
      ;;
  esac
  if [ "$status" = "409" ] && [ "$allow409" = "allow409" ]; then
    rollouts_last_body="$response"
    return 0
  fi
  if [ "$status" -ge 400 ]; then
    rollouts_unavailable
    return 0
  fi
  rollouts_last_body="$response"
}

rollouts_write_state() {
  jq -nc "$@" > "$rollouts_state_file" || rollouts_note "could not save the local report state."
}

if [ "${1:-}" = "finish" ]; then
  if [ ! -f "$rollouts_state_file" ]; then
    exit 0
  fi
  rollouts_was_stopped="$(jq -r 'if .stopped == true then "true" else "false" end' "$rollouts_state_file" 2>/dev/null || true)"
  rollouts_saved="$(jq -r '.deployment // empty' "$rollouts_state_file" 2>/dev/null || true)"
  if [ "$rollouts_was_stopped" = "true" ] || [ -z "$rollouts_saved" ]; then
    exit 0
  fi
fi

if ! command -v jq >/dev/null 2>&1; then
  rollouts_note "jq is not installed, so the deploy was not reported."
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  rollouts_note "curl is not installed, so the deploy was not reported."
  exit 0
fi

if [ -z "${CURSOR_API_KEY:-}" ]; then
  rollouts_error "CURSOR_API_KEY is missing. Create a team API key at https://cursor.com/dashboard/api-keys and store it as the CURSOR_API_KEY secret. The deploy continues."
  exit 0
fi

rollouts_missing=""
for rollouts_name in CHANGE_MONITOR_ENV CHANGE_MONITOR_SERVICE DEPLOY_VERSION CHANGE_MONITOR_SOURCE CHANGE_MONITOR_ACTOR; do
  eval "rollouts_value=\${$rollouts_name:-}"
  if [ -z "$rollouts_value" ]; then
    rollouts_missing="$rollouts_missing $rollouts_name"
  fi
done
if [ -n "$rollouts_missing" ]; then
  rollouts_note "required environment is missing:${rollouts_missing}. The deploy was not reported."
  exit 0
fi

case "${1:-}" in
  bootstrap|start|finish)
    rollouts_exchange
    ;;
  *)
    rollouts_note "unknown command '${1:-}'. Expected bootstrap, start, or finish. The deploy was not reported."
    exit 0
    ;;
esac

case "${1:-}" in
  bootstrap)
    if rollouts_json "CreateEnvironment" --arg env "$CHANGE_MONITOR_ENV" '{environmentId:$env,environment:{displayName:$env}}'; then
      rollouts_post CreateEnvironment https://api.cursor.com/factory.v1.DeploymentsService/CreateEnvironment \
        "$rollouts_value" allow409
    fi
    if rollouts_json "CreateService" --arg service "$CHANGE_MONITOR_SERVICE" '{serviceId:$service,service:{displayName:$service}}'; then
      rollouts_post CreateService https://api.cursor.com/factory.v1.DeploymentsService/CreateService \
        "$rollouts_value" allow409
    fi
    ;;
  start)
    DEPLOYMENT=""
    if [ "$rollouts_stopped" -eq 0 ] && rollouts_json "CreateDeployment" \
      --arg source "$CHANGE_MONITOR_SOURCE" \
      --arg env "$CHANGE_MONITOR_ENV" \
      --arg version "$DEPLOY_VERSION" \
      --arg service "$CHANGE_MONITOR_SERVICE" \
      --arg actor "$CHANGE_MONITOR_ACTOR" \
      '{deployment:{deploySourceUri:$source,environment:("environments/"+$env),deployVersion:$version,service:("services/"+$service)},event:{started:{},actor:$actor}}'; then
      rollouts_post CreateDeployment https://api.cursor.com/factory.v1.DeploymentsService/CreateDeployment \
        "$rollouts_value"
      if [ "$rollouts_stopped" -eq 0 ]; then
        DEPLOYMENT="$(jq -r '.deployment.name // empty' "$rollouts_last_body" 2>/dev/null || true)"
        if [ -z "$DEPLOYMENT" ]; then
          rollouts_unavailable
        fi
      fi
    fi
    if [ "$rollouts_stopped" -eq 1 ] || [ -z "$DEPLOYMENT" ]; then
      rollouts_write_state '{stopped:true}'
    else
      rollouts_write_state --arg deployment "$DEPLOYMENT" '{deployment:$deployment}'
    fi
    ;;
  finish)
    case "${ROLLOUTS_OUTCOME:-}" in
      success) kind="succeeded" ;;
      cancelled) kind="aborted" ;;
      *) kind="failed" ;;
    esac
    if [ "$kind" = "succeeded" ]; then
      rollouts_json "AppendDeploymentEvent" --arg name "$rollouts_saved" --arg actor "$CHANGE_MONITOR_ACTOR" \
        '{name:$name,event:{completed:{succeeded:{}},actor:$actor}}'
    elif [ "$kind" = "aborted" ]; then
      rollouts_json "AppendDeploymentEvent" --arg name "$rollouts_saved" --arg actor "$CHANGE_MONITOR_ACTOR" \
        '{name:$name,event:{aborted:{},actor:$actor}}'
    else
      rollouts_json "AppendDeploymentEvent" --arg name "$rollouts_saved" --arg actor "$CHANGE_MONITOR_ACTOR" --arg message "Deploy step failed" \
        '{name:$name,event:{completed:{failed:{message:$message}},actor:$actor}}'
    fi
    if [ "$rollouts_stopped" -eq 0 ]; then
      rollouts_post AppendDeploymentEvent https://api.cursor.com/factory.v1.DeploymentsService/AppendDeploymentEvent \
        "$rollouts_value"
    fi
    ;;
esac
exit 0
