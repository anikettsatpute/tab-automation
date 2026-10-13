#!/data/data/com.termux/files/usr/bin/bash
# Boot + manual runner: keeps the bot alive with wake lock + auto-restart.
# Usage: bash ~/tab-automation/termux/run.sh
DIR="$HOME/tab-automation"
LOG="$DIR/data/bot.log"
mkdir -p "$DIR/data"
termux-wake-lock 2>/dev/null || true
cd "$DIR"
echo "Starting tab-automation at $(date)" | tee -a "$LOG"
while true; do
  node src/index.js 2>&1 | tee -a "$LOG"
  echo "Process exited at $(date), restarting in 5s..." | tee -a "$LOG"
  sleep 5
done
