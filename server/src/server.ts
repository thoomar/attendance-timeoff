import 'dotenv/config';
import http from 'http';
import app from './app';

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer(app);

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`attendance-tracker-api listening on http://${HOST}:${PORT}`);
});

/**
 * Graceful shutdown & basic hardening
 */
const shutdown = (signal: string) => {
  // eslint-disable-next-line no-console
  console.log(`${signal} received, shutting down…`);
  server.close(() => {
    // eslint-disable-next-line no-console
    console.log('HTTP server closed');
    process.exit(0);
  });

  // Force-exit if it hangs
  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error('Forced shutdown');
    process.exit(1);
  }, 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
