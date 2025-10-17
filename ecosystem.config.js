module.exports = {
  apps: [
    {
      name: 'barbitch-strapi',
      script: 'npm',
      args: 'start',
      cwd: '/opt/barbitch-strapi',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 1350
      },
      error_file: '/var/log/pm2/barbitch-strapi-error.log',
      out_file: '/var/log/pm2/barbitch-strapi-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true
    }
  ]
};
