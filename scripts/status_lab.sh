#!/bin/bash
# Show launchd status for NeuroPilot nightly lab.
launchctl list | grep -E "neuropilot|com.neuropilot" || echo "No neuropilot lab job found."
