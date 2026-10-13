#!/data/data/com.termux/files/usr/bin/bash
# Run INSIDE Termux on the Samsung Tab (SM-T595).
# One-time setup: copies project from shared storage, installs Node deps.
set -e

echo "=== tab-automation Termux setup ==="
pkg update -y
pkg install -y nodejs-lts git termux-api termux-services

SRC="/sdcard/tab-automation"
DST="$HOME/tab-automation"
if [ -d "$SRC" ]; then
  echo "Copying $SRC -> $DST"
  rm -rf "$DST"
  cp -r "$SRC" "$DST"
else
  echo "NOTE: $SRC not found. Assuming you are already in the project dir."
  DST="$(pwd)"
fi

cd "$DST"
npm install --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from example. EDIT IT NOW: nano .env"
else
  echo ".env already exists, leaving it."
fi

mkdir -p ~/.termux/boot
cp -f termux/boot-tab-automation.sh ~/.termux/boot/boot-tab-automation.sh 2>/dev/null || true
chmod +x ~/.termux/boot/boot-tab-automation.sh 2>/dev/null || true

echo ""
echo "Next:"
echo "  1) nano $DST/.env   (fill DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, AZURE_OPENAI_*)"
echo "  2) node $DST/src/validate.js"
echo "  3) bash $DST/termux/run.sh"
