#!/bin/zsh

set -e

PROJECT_DIRECTORY=${0:A:h}
cd "$PROJECT_DIRECTORY"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "OpenCNC needs pnpm. Install Node.js and pnpm, then try again."
  echo
  read -k 1 "?Press any key to close..."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Preparing OpenCNC for first use..."
  pnpm install
fi

WORKSPACE_DIRECTORY=$(osascript -e 'POSIX path of (choose folder with prompt "Choose the parent folder that contains the exported CIX project folders")')

echo "Watching: $WORKSPACE_DIRECTORY"
echo "Verified outputs will be written to each project folder's BPP subfolder."
echo "Keep this window open. Press Control-C to stop."
echo
pnpm opencnc watch "$WORKSPACE_DIRECTORY" --interval 10
