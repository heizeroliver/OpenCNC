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

echo "Starting OpenCNC Workshop..."
echo "Keep this window open while using the viewer."
pnpm viewer:open
