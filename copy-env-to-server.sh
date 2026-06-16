#!/bin/bash
#
# Copy .env.production to server shared dir (mirrors ~/waha-web workflow)
# Usage:
#   ./copy-env-to-server.sh
#   METABIZ_DEPLOY_HOSTS=143.198.219.81,168.144.132.171 ./copy-env-to-server.sh
#

set -euo pipefail

IFS=',' read -r -a SERVERS <<< "${METABIZ_DEPLOY_HOSTS:-143.198.219.81,168.144.132.171}"
USER="${METABIZ_DEPLOY_USER:-waha}"
REMOTE_PATH="/opt/metabiz-whatsapp-headless/shared"

if [ ! -f .env.production ]; then
  echo "❌ .env.production not found in repo root"
  echo "   Create it locally (API_KEY, PORT, DEV_MODE, HEADLESS) then re-run."
  exit 1
fi

echo "📋 Copying environment file to server..."
for SERVER in "${SERVERS[@]}"; do
  SERVER="$(echo "${SERVER}" | xargs)"
  [ -n "${SERVER}" ] || continue

  TARGET="${USER}@${SERVER}"
  ssh "${TARGET}" "mkdir -p ${REMOTE_PATH}"
  scp .env.production "${TARGET}:${REMOTE_PATH}/.env"
done

echo "✅ Environment file copied successfully!"
echo "   ${REMOTE_PATH}/.env"

