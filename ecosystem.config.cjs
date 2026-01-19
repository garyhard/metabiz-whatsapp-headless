// PM2 Ecosystem File with Deploy Configuration
// Usage:
//   pm2 deploy ecosystem.config.cjs production setup
//   pm2 deploy ecosystem.config.cjs production

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
      max_memory_restart: '2G',
    },
  ],

  deploy: {
    production: {
      user: 'waha',
      host: ['wahaweb'], // Uses SSH config alias
      ref: 'origin/main',
      // TODO: replace with your repo
      repo: 'git@github.com:garyhard/metabiz-whatsapp-headless.git',
      path: '/opt/metabiz-whatsapp-headless',
      'pre-setup': 'mkdir -p /opt/metabiz-whatsapp-headless/shared/{logs,profiles} && echo "⚠️  Remember to copy .env.production to /opt/metabiz-whatsapp-headless/shared/.env before first deploy"',
      'post-deploy': 'chmod +x /opt/metabiz-whatsapp-headless/current/deploy.sh && bash /opt/metabiz-whatsapp-headless/current/deploy.sh',
      env: {
        NODE_ENV: 'production',
      },
    },
  },
};

