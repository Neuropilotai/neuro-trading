#!/bin/bash
# Start caffeinate so the Mac doesn't sleep during the lab, then load and start the nightly job.
caffeinate -dimsu &
CAFFEINATE_PID=$!

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.neuropilot.nightlylab.plist 2>/dev/null || true
launchctl kickstart -k gui/$(id -u)/com.neuropilot.nightlylab

echo "NeuroPilot Lab started with caffeinate"
