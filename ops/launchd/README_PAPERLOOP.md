# Paper loop + dashboard (launchd)

- **Loop script:** `engine/scripts/runPaperLoopWithDashboard.sh` — `paper:refresh-chain` then `buildGovernanceDashboard.js`, lock `/tmp/neuropilot_paper_loop_dashboard.lock`, log under `$NEUROPILOT_DATA_ROOT/logs/paper_loop_dashboard.log`.
- **Plist template:** `com.neuropilot.paperloop.plist` — not auto-installed; copy to `~/Library/LaunchAgents/` and `launchctl load`.
- Adjust **WorkingDirectory**, **ProgramArguments** script path, **NEUROPILOT_DATA_ROOT**, and **StandardOutPath/StandardErrorPath** if your machine differs.
