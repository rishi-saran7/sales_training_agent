// ── Structured Logger ────────────────────────────────────────────────────────
// Thin wrapper around pino that attaches session_id + user_id to every log line.
// In production pipe through `pino-pretty` or ship JSON logs to your aggregator.
//
// Usage:
//   const log = require('./lib/logger');
//   log.info({ sessionId, userId }, 'Call started');
//   const child = log.child({ sessionId: 'abc', userId: 'xyz' });
//   child.info('Something happened');
//
// TODO: Add log aggregation (Datadog, Loki, CloudWatch).
// TODO: Add request-scoped correlation IDs for distributed tracing.

const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  // In dev, use pino-pretty for human-readable output.
  // In production, emit raw JSON for log aggregators.
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }),
});

module.exports = logger;
