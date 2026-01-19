#!/bin/bash
#
# Copy .env.production to server shared dir (mirrors ~/waha-web workflow)
# Usage: ./copy-env-to-server.sh
#

set -euo pipefail

SERVER="wahaweb"
REMOTE_PATH="/opt/metabiz-whatsapp-headless/shared"

if [ ! -f .env.production ]; then
  echo "❌ .env.production not found in repo root"
  echo "   Create it locally (API_KEY, PORT, DEV_MODE, HEADLESS) then re-run."
  exit 1
fi

echo "📋 Copying environment file to server..."
ssh "${SERVER}" "mkdir -p ${REMOTE_PATH}"
scp .env.production "${SERVER}:${REMOTE_PATH}/.env"

echo "✅ Environment file copied successfully!"
echo "   ${REMOTE_PATH}/.env"


