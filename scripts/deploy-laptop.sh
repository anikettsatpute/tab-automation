#!/bin/bash
# Laptop deploy: headless bot (Discord + Control Room) + persistent tunnel.
# Tunnel sirf tab chalta hai jab config/dashboard.json me enabled=true ho.
# Deploy ke baad tunnel NAHI marta — wahi URL rehta hai.
# Usage: bash scripts/deploy-laptop.sh [--no-tunnel]
set -u
cd "$(dirname "$0")/.."

PORT="${HEADLESS_PORT:-3000}"
echo "=== laptop deploy: headless bot on :$PORT ==="

# 1. validate
node src/validate.js 2>&1 | tail -3 || { echo "Validate failed — fix config first."; exit 1; }

# 2. build dashboard UI (headless serves dist-dashboard/)
npm run dashboard:build 2>&1 | tail -2

# 3. stop old headless only (tunnel ko haath mat lagao)
for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
  if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "node src/index.js"; then
    kill -9 "$pid" 2>/dev/null && echo "stopped old headless ($pid)"
  fi
done
sleep 2

# 4. start headless
HEADLESS_PORT="$PORT" nohup node src/index.js > /tmp/headless-$PORT.log 2>&1 &
sleep 6
if ! curl -s -m 8 "http://localhost:$PORT/api/health" | grep -q '"ok":true'; then
  echo "ERROR: headless health check failed. Log:"
  tail -15 /tmp/headless-$PORT.log
  exit 1
fi
echo "Headless live: http://localhost:$PORT/dashboard"

# 5. tunnel (dashboard on hai tabhi; persistent — deploy ke baad bhi rahega)
if [ "${1:-}" != "--no-tunnel" ]; then
  DASH_ON=$(node -e "try{const j=require('./config/dashboard.json');console.log(j.enabled===false?'0':'1')}catch(e){console.log('1')}" 2>/dev/null || echo "1")
  if [ "$DASH_ON" = "1" ]; then
    echo "Dashboard ON — ensuring persistent tunnel..."
    HEADLESS_PORT="$PORT" bash scripts/tunnel.sh start || echo "Tunnel failed — bot phir bhi live hai."
  else
    echo "Dashboard OFF — tunnel skipped."
  fi
fi

echo ""
echo "Done. Bot: :$PORT | Dashboard: :$PORT/dashboard | Tunnel: $(cat data/tunnel-url.txt 2>/dev/null || echo '—')"
