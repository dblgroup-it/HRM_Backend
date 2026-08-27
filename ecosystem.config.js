// PM2 ecosystem for the DBL HRM backend.
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

      // DO NOT raise `instances` / switch to exec_mode: 'cluster' without
      // first wiring a Socket.IO cluster adapter (e.g. @socket.io/cluster-adapter
      // + a custom IoAdapter in main.ts) AND solving sticky sessions. Right now
      // EventsGateway.broadcast() is a plain `this.server.emit()`, which only
      // reaches clients connected to the SAME worker — under cluster mode most
      // users would silently stop receiving requisition:changed, candidate:changed
      // and notification events. Single instance avoids this entirely.
      instances: 1,
      exec_mode: 'fork',

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
