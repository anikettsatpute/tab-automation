#!/bin/bash
# Deploy: pushes code to the Tab WITHOUT wiping data/ (memory, finance history, logs).
# Tunnel: agar config/dashboard.json me enabled=true hai to persistent cloudflared
# tunnel bhi ensure hota hai (scripts/tunnel.sh) — deploy ke baad bhi wahi URL rahega.
# Usage: bash scripts/deploy-tab.sh [--no-tunnel]
set -e
cd "$(dirname "$0")/.."
STAGE=/tmp/tab-auto-push-safe
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp package.json package-lock.json .env.example .gitignore README.md termux-run.sh termux-setup.sh "$STAGE/"
cp -r config src termux scripts "$STAGE/"
# dashboard build artifacts bhi bhejo (headless Control Room ke liye)
[ -d dist-dashboard ] && cp -r dist-dashboard "$STAGE/" || echo "NOTE: dist-dashboard missing — run: npm run dashboard:build"
adb push "$STAGE" /sdcard/tab-automation/stage >/dev/null
adb shell "cp -r /sdcard/tab-automation/stage/* /sdcard/tab-automation/ && rm -rf /sdcard/tab-automation/stage && run-as com.termux sh -c 'mkdir -p files/home/tab-automation/data && cp -r /sdcard/tab-automation/config /sdcard/tab-automation/src /sdcard/tab-automation/package.json /sdcard/tab-automation/package-lock.json files/home/tab-automation/ && echo SYNCED'" 2>&1 | tail -1
echo "Deploy synced (data/ preserved). Restart bot on Tab to pick up changes."
# ---- tunnel (dashboard on hai tabhi, deploy se alag persistent process) ----
if [ "${1:-}" != "--no-tunnel" ]; then
  DASH_ON=$(node -e "try{const j=require('./config/dashboard.json');console.log(j.enabled===false?'0':'1')}catch(e){console.log('1')}" 2>/dev/null || echo "1")
  if [ "$DASH_ON" = "1" ]; then
    echo "Dashboard ON — ensuring persistent tunnel..."
    bash scripts/tunnel.sh start || echo "Tunnel start failed — bot phir bhi chalega, tunnel baad me: bash scripts/tunnel.sh start"
  else
    echo "Dashboard OFF — tunnel skipped (Step 8 Deploy me on karo)."
  fi
else
  echo "Tunnel skipped (--no-tunnel)."
fi
