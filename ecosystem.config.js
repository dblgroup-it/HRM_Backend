// PM2 ecosystem — 6-worker cluster for DBL HRM backend (6-core server)
// Usage:
//   pm2 start ecosystem.config.js          # start / restart
//   pm2 reload ecosystem.config.js         # zero-downtime reload
//   pm2 stop hrm-backend
//   pm2 logs hrm-backend
//   pm2 monit                              # live CPU/RAM dashboard
//   pm2 startup && pm2 save               # auto-start on server reboot

module.exports = {
  apps: [
    {
      name: 'hrm-backend',
      script: './dist/main.js',

      // Cluster mode: one worker per CPU core
      instances: 6,
      exec_mode: 'cluster',

      // Restart a worker that leaks past 1 GB (safety net)
      max_memory_restart: '1G',

      // Never restart more than 10× in 60 s (prevents crash loop)
      max_restarts: 10,
      min_uptime: '10s',

      // Always production
      node_args: '--max-old-space-size=512',
      env: {
        NODE_ENV: 'production',
      },

      // Write logs to files (PM2 rotates them)
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
