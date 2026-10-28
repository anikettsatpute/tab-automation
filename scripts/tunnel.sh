#!/bin/bash
# Tunnel manager: persistent cloudflared quick-tunnel for the headless Control Room.
# ONLY runs when config/dashboard.json has enabled=true (deploy script calls this).
# Persistent: reuses live tunnel if healthy, survives deploys (never killed by deploy).
# Usage: bash scripts/tunnel.sh [start|stop|status]
set -u
cd "$(dirname "$0")/.."

PID_FILE="data/cloudflared.pid"
LOG_FILE="data/cloudflared.log"
URL_FILE="data/tunnel-url.txt"
PORT="${HEADLESS_PORT:-3000}"

dashboard_enabled() {
  node -e "try{const j=require('./config/dashboard.json');console.log(j.enabled===false?'0':'1')}catch(e){console.log('1')}" 2>/dev/null || echo "1"
}

tunnel_alive() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid=$(cat "$PID_FILE" 2>/dev/null)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  # also verify it still points at our port
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "localhost:$PORT" || return 1
  return 0
}

current_url() {
  [ -f "$URL_FILE" ] && cat "$URL_FILE" 2>/dev/null || echo ""
  # refresh from log if empty
  if [ ! -s "$URL_FILE" ] && [ -f "$LOG_FILE" ]; then
    grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG_FILE" | tail -1 > "$URL_FILE" 2>/dev/null || true
    cat "$URL_FILE" 2>/dev/null || echo ""
  fi
}

do_start() {
  if [ "$(dashboard_enabled)" = "0" ]; then
    echo "Dashboard OFF in config/dashboard.json — tunnel not started."
    echo "Setup wizard Step 8 Deploy me Control Room on karo, phir deploy karo."
    exit 0
  fi
  if tunnel_alive; then
    echo "Tunnel already live (pid $(cat $PID_FILE)): $(current_url)"
    echo "Deploy ke baad bhi yahi chalega — kill nahi hoga."
    exit 0
  fi
  # stale pid cleanup
  rm -f "$PID_FILE"
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "ERROR: cloudflared not found. Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    exit 1
  fi
  mkdir -p data
  echo "Starting persistent tunnel -> http://localhost:$PORT ..."
  nohup cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  # wait for URL (max 25s)
  for i in $(seq 1 25); do
    sleep 1
    URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG_FILE" 2>/dev/null | tail -1)
    if [ -n "$URL" ]; then
      echo "$URL" > "$URL_FILE"
      echo "Tunnel live: $URL -> localhost:$PORT"
      echo "Ye URL deploy ke baad bhi rahega (pid $(cat $PID_FILE))."
      exit 0
    fi
  done
  echo "Tunnel started but URL not found yet — check: tail -20 $LOG_FILE"
  exit 1
}

do_stop() {
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    kill "$pid" 2>/dev/null && echo "Tunnel stopped (pid $pid)." || echo "Tunnel already dead."
    rm -f "$PID_FILE"
  else
    pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null && echo "Tunnel stopped." || echo "No tunnel running."
  fi
}

do_status() {
  ENABLED=$(dashboard_enabled)
  if tunnel_alive; then
    echo "{\"running\":true,\"url\":\"$(current_url)\",\"pid\":$(cat $PID_FILE),\"port\":$PORT,\"dashboardEnabled\":$([ "$ENABLED" = "1" ] && echo true || echo false)}"
  else
    echo "{\"running\":false,\"url\":\"$(current_url)\",\"pid\":null,\"port\":$PORT,\"dashboardEnabled\":$([ "$ENABLED" = "1" ] && echo true || echo false)}"
  fi
}

case "${1:-start}" in
  start) do_start ;;
  stop) do_stop ;;
  status) do_status ;;
  *) echo "Usage: $0 [start|stop|status]"; exit 1 ;;
esac
