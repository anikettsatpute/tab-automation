#!/bin/bash
# Data-safe deploy: pushes code to the Tab WITHOUT wiping data/ (memory, finance history, logs).
# Usage: bash scripts/deploy-tab.sh
set -e
cd "$(dirname "$0")/.."
STAGE=/tmp/tab-auto-push-safe
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp package.json package-lock.json .env.example .gitignore README.md termux-run.sh termux-setup.sh "$STAGE/"
cp -r config src termux "$STAGE/"
adb push "$STAGE" /sdcard/tab-automation/stage >/dev/null
adb shell "cp -r /sdcard/tab-automation/stage/* /sdcard/tab-automation/ && rm -rf /sdcard/tab-automation/stage && run-as com.termux sh -c 'mkdir -p files/home/tab-automation/data && cp -r /sdcard/tab-automation/config /sdcard/tab-automation/src /sdcard/tab-automation/package.json /sdcard/tab-automation/package-lock.json files/home/tab-automation/ && echo SYNCED'" 2>&1 | tail -1
echo "Deploy synced (data/ preserved). Restart bot on Tab to pick up changes."
