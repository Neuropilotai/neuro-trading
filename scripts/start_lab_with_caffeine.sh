#!/bin/bash
echo "Starting NeuroPilot Lab..."

caffeinate -dimsu &
CAFFEINE_PID=$!

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.neuropilot.nightlylab.plist 2>/dev/null || true
launchctl kickstart -k gui/$(id -u)/com.neuropilot.nightlylab

echo "Lab running with caffeinate (PID $CAFFEINE_PID)"
