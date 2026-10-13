#!/data/data/com.termux/files/usr/bin/sh
# Keepalive runner for tab-automation inside Termux.
# Holds a wake lock and restarts the bot if it crashes.
# Started once via: nohup sh ~/tab-automation/termux-run.sh > /dev/null 2>&1 &
export PATH=/data/data/com.termux/files/usr/bin:$PATH
cd /data/data/com.termux/files/home/tab-automation || exit 1
mkdir -p data
termux-wake-lock 2>/dev/null || true
while true; do
  echo "Starting tab-automation at $(date)" >> data/bot.log
  node src/index.js >> data/bot.log 2>&1
  echo "Exited at $(date), restarting in 5s" >> data/bot.log
  sleep 5
done
