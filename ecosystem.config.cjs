/**
 * PM2 ecosystem config — run the engine 24/7 as a daemon.
 *
 * Install: npm install -g pm2
 *
 * Start:   pm2 start ecosystem.config.cjs
 * Monitor: pm2 monit
 * Logs:    pm2 logs trading-engine
 * Stop:    pm2 stop trading-engine
 * Restart: pm2 restart trading-engine
 *
 * Auto-start on reboot:
 *   pm2 startup
 *   pm2 save
 */
module.exports = {
  apps: [
    {
      name: "trading-engine",
      script: "npx",
      args: "tsx src/live.ts -- --no-dashboard --exchanges binance --symbols BTC-USDT,ETH-USDT",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "development",
        LOG_LEVEL: "info",
      },
      // Log rotation
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/error.log",
      out_file: "logs/output.log",
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 5000,
    },
  ],
};
