module.exports = {
  apps: [
    {
      name: 'Barbitch strapi',
      script: 'npm start',
      env_production: {},
    },
  ],

  deploy: {
    production: {
      user: 'dimi',
      // eslint-disable-next-line sonarjs/no-hardcoded-ip
      host: ['89.221.216.23'],
      ref: 'origin/main',
      repo: 'git@github.com:simon1400/barbitch-strapi.git',
      path: '/home/dimi/app/barbitch/strapi',
      'post-deploy': 'npm i && npm run build && pm2 reload ecosystem.config.js --env production',
    },
  },
}
