// ── Error Monitor ────────────────────────────────────────────────────────────
// Central error-handling utilities.
//
// • Captures unhandled exceptions and unhandled promise rejections.
// • Provides an Express error-handler middleware (returns safe JSON to clients).
// • Sentry stub — swap in real Sentry DSN when ready.
//
// Usage:
//   const errorMonitor = require('./lib/errorMonitor');
//   errorMonitor.installGlobalHandlers();           // once, at startup
//   app.use(errorMonitor.expressErrorHandler);       // after all routes

const log = require('./logger');
const usage = require('./usageTracker');

// ── Sentry Stub ──────────────────────────────────────────────────────────────
// To enable real Sentry:
//   1. npm install @sentry/node
//   2. Set SENTRY_DSN env var
//   3. Uncomment the block below and remove the stub.

/*
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.2 });
}
*/

function captureException(err, context = {}) {
  // In production, forward to Sentry / Datadog / etc.
  // For now, just log.
  log.error({ err, ...context }, 'Captured exception');
  usage.trackError();
  // if (process.env.SENTRY_DSN) Sentry.captureException(err, { extra: context });
}

// ── Global handlers ──────────────────────────────────────────────────────────
function installGlobalHandlers() {
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception — process will exit');
    captureException(err, { fatal: true });
    // Give logger a moment to flush, then exit.
    setTimeout(() => process.exit(1), 500);
  });

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled promise rejection');
    captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });

  log.info('Global error handlers installed');
}

// ── Express error-handler middleware ─────────────────────────────────────────
// Must have 4 params to be recognized as an error handler by Express.
// eslint-disable-next-line no-unused-vars
function expressErrorHandler(err, req, res, _next) {
  captureException(err, { method: req.method, url: req.originalUrl });

  const status = err.statusCode || err.status || 500;
  const message =
    status < 500
      ? err.message
      : 'An internal error occurred. Please try again later.';

  res.status(status).json({ error: message });
}

module.exports = { captureException, installGlobalHandlers, expressErrorHandler };
