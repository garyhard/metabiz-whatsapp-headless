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

if [ "${ENABLE_PM2_LOGROTATE:-true}" = "true" ]; then
  echo "🧾 Ensuring PM2 log rotation..."
  if ! pm2 module:list 2>/dev/null | grep -q "pm2-logrotate"; then
    pm2 install pm2-logrotate || echo "⚠️  pm2-logrotate install failed; continuing deploy"
  fi
  pm2 set pm2-logrotate:max_size "${PM2_LOGROTATE_MAX_SIZE:-100M}" >/dev/null || true
  pm2 set pm2-logrotate:retain "${PM2_LOGROTATE_RETAIN:-14}" >/dev/null || true
  pm2 set pm2-logrotate:compress "${PM2_LOGROTATE_COMPRESS:-true}" >/dev/null || true
  pm2 set pm2-logrotate:rotateInterval "${PM2_LOGROTATE_INTERVAL:-0 0 * * *}" >/dev/null || true
fi

echo "🔄 Restarting service..."
pm2 startOrRestart ecosystem.config.cjs --update-env

echo "🩺 Waiting for health check..."
for attempt in $(seq 1 "${POST_DEPLOY_HEALTH_ATTEMPTS:-30}"); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${PORT:-4001}/health" >/dev/null; then
    echo "✅ Health check passed"
    break
  fi

  if [ "${attempt}" = "${POST_DEPLOY_HEALTH_ATTEMPTS:-30}" ]; then
    echo "❌ Health check failed after ${attempt} attempts"
    pm2 describe metabiz-whatsapp-headless || true
    tail -n 80 "${APP_DIR}/shared/logs/app-out.log" || true
    tail -n 80 "${APP_DIR}/shared/logs/app-error.log" || true
    exit 1
  fi

  sleep 5
done

echo "✅ Deployment complete!"
