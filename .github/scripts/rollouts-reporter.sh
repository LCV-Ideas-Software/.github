#!/bin/sh
# Reports one deploy to Cursor Rollouts. Entry points: bootstrap, start, finish.
# A failure to report prints one error and returns success so the deploy continues.

report_rollouts_auth_failure() {
  message="$1"
  echo "Rollouts reporter: ${message}" >&2
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::error title=Rollouts reporter::${message}" >&2
  fi
  if [ -n "${BUILDKITE:-}" ] && command -v buildkite-agent >/dev/null 2>&1; then
    buildkite-agent annotate --style error --context rollouts-reporter "${message}" || true
  fi
}

rollouts_stop_file="$(mktemp)"
rollouts_state_dir="${RUNNER_TEMP:-/tmp}"
rollouts_state_key="$(printf '%s' "${CHANGE_MONITOR_ENV:-}-${CHANGE_MONITOR_SERVICE:-}" | tr -c 'A-Za-z0-9._-' '_')"
rollouts_state_file="${rollouts_state_dir}/rollouts-${rollouts_state_key}.json"

rollouts_halt() {
  echo stopped > "$rollouts_stop_file"
  return 0
}

if [ "${1:-}" = "finish" ]; then
  if [ ! -f "$rollouts_state_file" ]; then
    exit 0
  fi
  rollouts_stopped="$(jq -r 'if .stopped == true then "true" else "false" end' "$rollouts_state_file" 2>/dev/null || true)"
  rollouts_already="$(jq -r 'if .alreadyCompleted == true then "true" else "false" end' "$rollouts_state_file" 2>/dev/null || true)"
  rollouts_saved="$(jq -r '.deployment // empty' "$rollouts_state_file" 2>/dev/null || true)"
  if [ "$rollouts_stopped" = "true" ] || [ "$rollouts_already" = "true" ] || [ -z "$rollouts_saved" ]; then
    exit 0
  fi
fi

if ! command -v jq >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
  rollouts_halt
fi

if [ -z "${CURSOR_API_KEY:-}" ]; then
  report_rollouts_auth_failure "CURSOR_API_KEY is missing. Create a team API key at https://cursor.com/dashboard/api-keys and store it as the CURSOR_API_KEY secret. The deploy continues."
  rollouts_halt
fi

if [ -z "${CHANGE_MONITOR_ENV:-}" ] || [ -z "${CHANGE_MONITOR_SERVICE:-}" ] || [ -z "${DEPLOY_VERSION:-}" ] || [ -z "${CHANGE_MONITOR_SOURCE:-}" ] || [ -z "${CHANGE_MONITOR_ACTOR:-}" ]; then
  echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
  rollouts_halt
fi

rollouts_exchange() {
  if [ -s "$rollouts_stop_file" ]; then
    return 0
  fi
  exchange_body="$(mktemp)"
  exchange_status="$(curl -sS -o "$exchange_body" -w "%{http_code}" -X POST https://api2.cursor.sh/auth/exchange_user_api_key \
    -H "Authorization: Bearer ${CURSOR_API_KEY}" -H "Content-Type: application/json" -d '{}')" || {
    echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
    rollouts_halt
    return 0
  }
  case "$exchange_status" in
    401|403)
      status="$exchange_status"
      call="the token exchange"
      report_rollouts_auth_failure "CURSOR_API_KEY was rejected (HTTP ${status}) by ${call}. Replace the CURSOR_API_KEY secret with a team API key from https://cursor.com/dashboard/api-keys. A personal key or a key with no team access is rejected. The deploy continues."
      rollouts_halt
      return 0
      ;;
    2*)
      ;;
    *)
      echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
      rollouts_halt
      return 0
      ;;
  esac
  TOKEN="$(jq -r '.accessToken // empty' "$exchange_body" 2>/dev/null || true)"
  if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
    rollouts_halt
    return 0
  fi
}

rollouts_post() {
  if [ -s "$rollouts_stop_file" ]; then
    return 0
  fi
  call="$1"
  url="$2"
  body="$3"
  allow409="${4:-}"
  response="$(mktemp)"
  status="$(curl -sS -o "$response" -w "%{http_code}" -X POST "$url" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -H "Connect-Protocol-Version: 1" \
    -d "$body")" || {
    echo "Rollouts reporter: ${call} failed before a response. The deploy continues." >&2
    rollouts_halt
    return 0
  }
  case "$status" in
    401|403)
      report_rollouts_auth_failure "CURSOR_API_KEY was rejected (HTTP ${status}) by ${call}. Replace the CURSOR_API_KEY secret with a team API key from https://cursor.com/dashboard/api-keys. A personal key or a key with no team access is rejected. The deploy continues."
      rollouts_halt
      return 0
      ;;
  esac
  if [ "$status" = "409" ] && [ "$allow409" = "allow409" ]; then
    return 0
  fi
  if [ "$status" -ge 400 ]; then
    echo "Rollouts reporter: ${call} returned HTTP ${status}. The deploy continues." >&2
    rollouts_halt
    return 0
  fi
  cat "$response"
}

if [ ! -s "$rollouts_stop_file" ]; then
  rollouts_exchange
fi

rollouts_write_stopped() {
  jq -nc '{stopped:true}' > "$rollouts_state_file" || true
}

case "${1:-}" in
  bootstrap)
    rollouts_body=""
    if [ ! -s "$rollouts_stop_file" ]; then
      rollouts_body="$(jq -nc --arg env "$CHANGE_MONITOR_ENV" '{environmentId:$env,environment:{displayName:$env}}' || true)"
      if [ -z "$rollouts_body" ] || [ "$rollouts_body" = "null" ]; then
        echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
        rollouts_halt
      fi
    fi
    env_body="$(mktemp)"
    rollouts_post CreateEnvironment https://api.cursor.com/factory.v1.DeploymentsService/CreateEnvironment \
      "$rollouts_body" allow409 > "$env_body"
    rollouts_body=""
    if [ ! -s "$rollouts_stop_file" ]; then
      rollouts_body="$(jq -nc --arg service "$CHANGE_MONITOR_SERVICE" '{serviceId:$service,service:{displayName:$service}}' || true)"
      if [ -z "$rollouts_body" ] || [ "$rollouts_body" = "null" ]; then
        echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
        rollouts_halt
      fi
    fi
    service_body="$(mktemp)"
    rollouts_post CreateService https://api.cursor.com/factory.v1.DeploymentsService/CreateService \
      "$rollouts_body" allow409 > "$service_body"
    ;;
  start)
    list_body="$(mktemp)"
    rollouts_body=""
    if [ ! -s "$rollouts_stop_file" ]; then
      rollouts_body="$(jq -nc \
        --arg source "$CHANGE_MONITOR_SOURCE" \
        --arg env "$CHANGE_MONITOR_ENV" \
        --arg version "$DEPLOY_VERSION" \
        --arg service "$CHANGE_MONITOR_SERVICE" \
        '{deploySourceUri:$source,filter:("environment = \"environments/"+$env+"\" AND deploy_version = \""+$version+"\" AND service = \"services/"+$service+"\""),pageSize:100,readMask:"events"}' || true)"
      if [ -z "$rollouts_body" ] || [ "$rollouts_body" = "null" ]; then
        echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
        rollouts_halt
      fi
    fi
    rollouts_post ListDeployments https://api.cursor.com/factory.v1.DeploymentsService/ListDeployments \
      "$rollouts_body" > "$list_body"
    DEPLOYMENT=""
    already="false"
    if [ ! -s "$rollouts_stop_file" ]; then
      DEPLOYMENT="$(jq -r --arg actor "$CHANGE_MONITOR_ACTOR" '
        [ .deployments[]? | select(any(.events[]?; .actor == $actor)) ][0].name // empty
      ' "$list_body" 2>/dev/null || true)"
      if [ -n "$DEPLOYMENT" ] && [ "$DEPLOYMENT" != "null" ]; then
        already="$(jq -r --arg actor "$CHANGE_MONITOR_ACTOR" --arg name "$DEPLOYMENT" '
          [ .deployments[]? | select(.name == $name) | .events[]?
            | select(.actor == $actor and ((.completed != null) or (.aborted != null))) ] | if length > 0 then "true" else "false" end
        ' "$list_body" 2>/dev/null || echo false)"
      else
        DEPLOYMENT=""
      fi
    fi
    deployment_body="$(mktemp)"
    if [ ! -s "$rollouts_stop_file" ] && [ -z "$DEPLOYMENT" ]; then
      rollouts_body=""
      rollouts_body="$(jq -nc \
        --arg source "$CHANGE_MONITOR_SOURCE" \
        --arg env "$CHANGE_MONITOR_ENV" \
        --arg version "$DEPLOY_VERSION" \
        --arg service "$CHANGE_MONITOR_SERVICE" \
        --arg actor "$CHANGE_MONITOR_ACTOR" \
        '{deployment:{deploySourceUri:$source,environment:("environments/"+$env),deployVersion:$version,service:("services/"+$service)},event:{started:{},actor:$actor}}' || true)"
      if [ -z "$rollouts_body" ] || [ "$rollouts_body" = "null" ]; then
        echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
        rollouts_halt
      fi
      rollouts_post CreateDeployment https://api.cursor.com/factory.v1.DeploymentsService/CreateDeployment \
        "$rollouts_body" > "$deployment_body"
      DEPLOYMENT="$(jq -r '.deployment.name // empty' "$deployment_body" 2>/dev/null || true)"
      if [ ! -s "$rollouts_stop_file" ] && { [ -z "$DEPLOYMENT" ] || [ "$DEPLOYMENT" = "null" ]; }; then
        echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
        rollouts_halt
      fi
    fi
    if [ -s "$rollouts_stop_file" ] || [ -z "$DEPLOYMENT" ] || [ "$DEPLOYMENT" = "null" ]; then
      rollouts_write_stopped
    else
      jq -nc --arg deployment "$DEPLOYMENT" --argjson alreadyCompleted "$([ "$already" = "true" ] && echo true || echo false)" \
        '{deployment:$deployment, alreadyCompleted:$alreadyCompleted}' > "$rollouts_state_file" || rollouts_write_stopped
    fi
    ;;
  finish)
    list_body="$(mktemp)"
    rollouts_body=""
    if [ ! -s "$rollouts_stop_file" ]; then
      rollouts_body="$(jq -nc \
        --arg source "$CHANGE_MONITOR_SOURCE" \
        --arg env "$CHANGE_MONITOR_ENV" \
        --arg version "$DEPLOY_VERSION" \
        --arg service "$CHANGE_MONITOR_SERVICE" \
        '{deploySourceUri:$source,filter:("environment = \"environments/"+$env+"\" AND deploy_version = \""+$version+"\" AND service = \"services/"+$service+"\""),pageSize:100,readMask:"events"}' || true)"
      if [ -z "$rollouts_body" ] || [ "$rollouts_body" = "null" ]; then
        echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
        rollouts_halt
      fi
    fi
    rollouts_post ListDeployments https://api.cursor.com/factory.v1.DeploymentsService/ListDeployments \
      "$rollouts_body" > "$list_body"
    if [ ! -s "$rollouts_stop_file" ]; then
      rollouts_done="$(jq -r --arg actor "$CHANGE_MONITOR_ACTOR" --arg name "$rollouts_saved" '
        [ .deployments[]? | select(.name == $name) | .events[]?
          | select(.actor == $actor and ((.completed != null) or (.aborted != null))) ] | if length > 0 then "true" else "false" end
      ' "$list_body" 2>/dev/null || echo false)"
      if [ "$rollouts_done" = "true" ]; then
        jq -nc --arg deployment "$rollouts_saved" '{deployment:$deployment, alreadyCompleted:true}' > "$rollouts_state_file" || true
        exit 0
      fi
    fi
    if [ -s "$rollouts_stop_file" ]; then
      exit 0
    fi
    case "${ROLLOUTS_OUTCOME:-}" in
      success) kind="succeeded" ;;
      cancelled) kind="aborted" ;;
      skipped) kind="aborted" ;;
      *) kind="failed" ;;
    esac
    event_body="$(mktemp)"
    rollouts_body=""
    if [ "$kind" = "succeeded" ]; then
      rollouts_body="$(jq -nc --arg name "$rollouts_saved" --arg actor "$CHANGE_MONITOR_ACTOR" \
        '{name:$name,event:{completed:{succeeded:{}},actor:$actor}}' || true)"
    elif [ "$kind" = "aborted" ]; then
      rollouts_body="$(jq -nc --arg name "$rollouts_saved" --arg actor "$CHANGE_MONITOR_ACTOR" \
        '{name:$name,event:{aborted:{},actor:$actor}}' || true)"
    else
      rollouts_body="$(jq -nc --arg name "$rollouts_saved" --arg actor "$CHANGE_MONITOR_ACTOR" --arg message "Deploy step failed" \
        '{name:$name,event:{completed:{failed:{message:$message}},actor:$actor}}' || true)"
    fi
    if [ -z "$rollouts_body" ] || [ "$rollouts_body" = "null" ]; then
      echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
      rollouts_halt
    fi
    rollouts_post AppendDeploymentEvent https://api.cursor.com/factory.v1.DeploymentsService/AppendDeploymentEvent \
      "$rollouts_body" > "$event_body"
    if [ ! -s "$rollouts_stop_file" ]; then
      jq -nc --arg deployment "$rollouts_saved" '{deployment:$deployment, alreadyCompleted:true}' > "$rollouts_state_file" || true
    fi
    ;;
  *)
    echo "Rollouts reporter: Rollouts API unavailable, deploy not reported" >&2
    ;;
esac
exit 0
