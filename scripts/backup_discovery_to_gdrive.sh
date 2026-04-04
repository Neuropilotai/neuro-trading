#!/usr/bin/env bash
#
# Backup Discovery outputs and brain snapshots from 5TB to Google Drive.
# Run periodically (cron or manual). Do not run discovery from inside GDrive.
#
# Copy:
#   - 5TB discovery/     -> $NEUROPILOT_GDRIVE_BACKUP_ROOT/discovery_backups/
#   - 5TB brain_snapshots/ -> $NEUROPILOT_GDRIVE_BACKUP_ROOT/brain_backups/
#
# Usage:
#   source ~/.zshrc   # or export both variables
#   ./scripts/backup_discovery_to_gdrive.sh          # backup (overwrites latest)
#   ./scripts/backup_discovery_to_gdrive.sh --dated  # backup with date suffix (recommended en fin de session)

set -e

DATA_ROOT="${NEUROPILOT_DATA_ROOT:-/Volumes/My Passport/NeuroPilotAI}"
GDRIVE_ROOT="${NEUROPILOT_GDRIVE_BACKUP_ROOT:-}"
DATED=false

for arg in "$@"; do
  case "$arg" in
    --dated) DATED=true ;;
  esac
done

if [[ -z "$GDRIVE_ROOT" ]]; then
  echo "Set NEUROPILOT_GDRIVE_BACKUP_ROOT (e.g. .../Neuro.Pilot.AI/backups). Add to ~/.zshrc and source it." >&2
  exit 1
fi

if [[ ! -d "$DATA_ROOT" ]]; then
  echo "5TB not mounted or NEUROPILOT_DATA_ROOT wrong: $DATA_ROOT" >&2
  exit 1
fi

SUFFIX=""
if $DATED; then
  SUFFIX="_$(date +%Y%m%d_%H%M)"
fi

mkdir -p "$GDRIVE_ROOT/discovery_backups"
mkdir -p "$GDRIVE_ROOT/brain_backups"

if [[ -d "$DATA_ROOT/discovery" ]]; then
  cp -R "$DATA_ROOT/discovery" "$GDRIVE_ROOT/discovery_backups/discovery${SUFFIX}"
  echo "Backed up: discovery -> discovery_backups/discovery${SUFFIX}"
fi

if [[ -d "$DATA_ROOT/brain_snapshots" ]]; then
  cp -R "$DATA_ROOT/brain_snapshots" "$GDRIVE_ROOT/brain_backups/brain_snapshots${SUFFIX}"
  echo "Backed up: brain_snapshots -> brain_backups/brain_snapshots${SUFFIX}"
fi

echo "Done."
