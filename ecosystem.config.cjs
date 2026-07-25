// PM2 Ecosystem File with Deploy Configuration
// Usage:
//   pm2 deploy ecosystem.config.cjs production setup
//   pm2 deploy ecosystem.config.cjs production

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT;
const REPO_URL = GITHUB_TOKEN
  ? `https://x-access-token:${GITHUB_TOKEN}@github.com/garyhard/metabiz-whatsapp-headless.git`
  : 'git@github.com:garyhard/metabiz-whatsapp-headless.git';
const DEPLOY_HOSTS = (process.env.METABIZ_DEPLOY_HOSTS || '143.198.219.81,168.144.132.171')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

module.exports = {
  apps: [
    {
      name: 'metabiz-whatsapp-headless',
      script: './src/server.js',
      cwd: '/opt/metabiz-whatsapp-headless/current',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/opt/metabiz-whatsapp-headless/shared/logs/app-error.log',
      out_file: '/opt/metabiz-whatsapp-headless/shared/logs/app-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_memory_restart: process.env.METABIZ_PM2_MAX_MEMORY_RESTART || '6G',
    },
  ],

  deploy: {
    production: {
      user: 'waha',
      host: DEPLOY_HOSTS,
      ref: 'origin/main',
      repo: REPO_URL,
      path: '/opt/metabiz-whatsapp-headless',
      'pre-setup': 'mkdir -p /opt/metabiz-whatsapp-headless/shared/{logs,profiles} && echo "⚠️  Remember to copy .env.production to /opt/metabiz-whatsapp-headless/shared/.env before first deploy"',
      'post-deploy': 'chmod +x /opt/metabiz-whatsapp-headless/current/deploy.sh && bash /opt/metabiz-whatsapp-headless/current/deploy.sh',
    },
  },
};
