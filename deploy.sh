#!/bin/bash
#
# Deployment script executed by PM2 Deploy
# Mirrors ~/waha-web deploy flow (Capistrano-style /opt/<app>/{releases,current,shared})
#

set -euo pipefail

APP_DIR="/opt/metabiz-whatsapp-headless"

cd "${APP_DIR}/current"

echo "📋 Copying environment file..."
if [ ! -f "${APP_DIR}/shared/.env" ]; then
  echo "❌ Missing ${APP_DIR}/shared/.env"
  echo "   Copy your production env file first (see copy-env-to-server.sh)."
  exit 1
fi
cp "${APP_DIR}/shared/.env" .env

echo "📦 Installing dependencies..."
npm ci --production=false

echo "🎭 Installing Playwright Chromium (if needed)..."
npx playwright install chromium

echo "🔄 Restarting service..."
pm2 reload ecosystem.config.js --env production

echo "✅ Deployment complete!"


