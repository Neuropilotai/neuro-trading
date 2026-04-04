#!/bin/bash
# Unload (bootout) the nightly lab job.
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.neuropilot.nightlylab.plist 2>/dev/null || true
