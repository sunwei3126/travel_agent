#!/usr/bin/env bash
# Crash-resume acceptance: kill the server mid-research, restart it, and verify
# the durable run resumes and completes without repeating completed searches.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if command -v cygpath >/dev/null 2>&1; then
  DATA_ROOT="$(cygpath -m "$ROOT/data")"
else
  DATA_ROOT="$ROOT/data"
fi
PORT="${PORT:-4100}"
API_URL="${API_URL:-http://127.0.0.1:${PORT}}"
BRIEF="泰山玩三天，2026-10-26 从上海虹桥火车站出发，自己去，预算 3000，体力一般，在意风景和美食"
MAX_SEARCHES=40

: "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be set}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

DATA_DIR="$DATA_ROOT/acceptance-crash-$$"
LOG_FILE="$DATA_DIR/server.log"
SERVER_PID=""
TRIP_ID=""

mkdir -p "$DATA_DIR"

log() {
  printf '%s\n' "$*"
}

fail() {
  log "FAIL: $*" >&2
  if [ -f "$LOG_FILE" ]; then
    log "--- server log (tail) ---" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
  fi
  exit 1
}

json_get() {
  node -e '
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      let value;
      try {
        value = JSON.parse(data);
      } catch {
        process.exit(2);
      }
      for (const key of process.argv[1].split(".")) {
        if (value === null || value === undefined) break;
        value = value[key];
      }
      if (value === undefined || value === null) return;
      process.stdout.write(String(value));
    });
  ' "$1"
}

api_get() {
  curl -fsS --max-time 10 "$API_URL$1"
}

api_post() {
  curl -fsS --max-time 30 -X POST \
    -H "content-type: application/json" \
    --data "$2" \
    "$API_URL$1"
}

wait_for_health() {
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 2 "$API_URL/health" >/dev/null 2>&1; then
      return 0
    fi
    if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
      return 1
    fi
    sleep 1
  done
  return 1
}

start_server() {
  DATA_DIR="$DATA_DIR" PORT="$PORT" DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
    node --import tsx apps/server/src/main.ts >>"$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  wait_for_health || fail "server failed to start"
  log "server listening on $API_URL (pid $SERVER_PID)"
}

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -9 "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
}

wait_for_port_release() {
  local deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! curl -fsS --max-time 1 "$API_URL/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_research() {
  local deadline=$((SECONDS + 300))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body search fetch
    if body=$(api_get "/api/trips/$TRIP_ID"); then
      search=$(printf '%s' "$body" | json_get research.searchCount || true)
      fetch=$(printf '%s' "$body" | json_get research.fetchCount || true)
      if [ "${search:-0}" -gt 0 ] || [ "${fetch:-0}" -gt 0 ]; then
        printf '%s %s\n' "${search:-0}" "${fetch:-0}"
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

wait_for_completion() {
  local deadline=$((SECONDS + 900))
  local started=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body running days
    if body=$(api_get "/api/trips/$TRIP_ID"); then
      running=$(printf '%s' "$body" | json_get running || true)
      days=$(printf '%s' "$body" | json_get plan.days.length || true)
      if [ "$running" = "true" ]; then
        started=1
      fi
      if [ "$running" = "false" ] && [ "$days" = "3" ]; then
        return 0
      fi
      if [ "$started" = "1" ] && [ "$running" = "false" ]; then
        return 0
      fi
    fi
    sleep 3
  done
  return 1
}

cleanup() {
  stop_server
  rm -rf "$DATA_DIR"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "starting server (data: $DATA_DIR)"
start_server

trip=$(api_post "/api/trips" '{"title":"泰山三日游","destination":"泰山","startDate":"2026-10-26","days":3}') ||
  fail "could not create trip"
TRIP_ID=$(printf '%s' "$trip" | json_get tripId)
[ -n "$TRIP_ID" ] || fail "create trip returned no tripId"
log "created trip $TRIP_ID"

request_id=$(node -e 'process.stdout.write(crypto.randomUUID())')
message=$(node -e '
  process.stdout.write(JSON.stringify({ content: process.argv[1], requestId: process.argv[2] }));
' "$BRIEF" "$request_id")
api_post "/api/trips/$TRIP_ID/messages" "$message" >/dev/null ||
  fail "could not submit the brief"
log "submitted the Tai Shan brief"

if ! research_counts=$(wait_for_research); then
  fail "no research activity appeared before timeout"
fi
read -r before_search before_fetch <<<"$research_counts"
log "research started: searchCount=$before_search fetchCount=$before_fetch"

log "killing server with SIGKILL"
kill -9 "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
wait_for_port_release || fail "port $PORT did not close after kill"

log "restarting server"
start_server

wait_for_completion || fail "run did not finish after restart"

final=$(api_get "/api/trips/$TRIP_ID") || fail "could not read final snapshot"
final_running=$(printf '%s' "$final" | json_get running)
final_days=$(printf '%s' "$final" | json_get plan.days.length)
final_budget=$(printf '%s' "$final" | json_get plan.budget.cap)
final_search=$(printf '%s' "$final" | json_get research.searchCount)

[ "$final_running" = "false" ] || fail "run is still running after restart"
[ "$final_days" = "3" ] || fail "expected 3 day cards, got ${final_days:-0}"
[ -n "$final_budget" ] || fail "plan.budget is missing"
[ "${final_search:-0}" -le "$MAX_SEARCHES" ] ||
  fail "searchCount $final_search exceeded the cap of $MAX_SEARCHES"

log "PASS: resumed run completed with searchCount=$final_search (before kill: $before_search), budget cap ¥$final_budget"
