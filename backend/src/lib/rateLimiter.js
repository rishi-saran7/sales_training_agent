// ── Rate Limiter ─────────────────────────────────────────────────────────────
// Middleware wrappers around express-rate-limit for different endpoint tiers.
//
// Tiers:
//   api     – General REST endpoints (100 req / 15 min per IP)
//   auth    – Login / signup (20 req / 15 min per IP)
//   heavy   – LLM / analytics-intensive routes (30 req / 15 min per IP)
//
// Usage:
//   const { apiLimiter, authLimiter, heavyLimiter } = require('./lib/rateLimiter');
//   app.use('/api', apiLimiter);
//   app.use('/api/auth', authLimiter);
//   app.use('/api/analytics', heavyLimiter);

const rateLimit = require('express-rate-limit');
const log = require('./logger');

function buildLimiter(name, windowMs, max) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,  // Return rate-limit info in RateLimit-* headers.
    legacyHeaders: false,
    // Use authenticated user ID when available; otherwise let the library default to IP.
    keyGenerator: (req) => {
      return req.user?.id || undefined; // returning undefined falls back to default IP handling.
    },
    // Disable the IPv6 validation since we fall back to the library's default IP handler.
    validate: { xForwardedForHeader: false, ip: false },
    handler: (_req, res) => {
      log.warn({ limiter: name }, 'Rate limit exceeded');
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
    },
  });
}

const apiLimiter   = buildLimiter('api',   15 * 60 * 1000, 100);
const authLimiter  = buildLimiter('auth',  15 * 60 * 1000,  20);
const heavyLimiter = buildLimiter('heavy', 15 * 60 * 1000,  30);

module.exports = { apiLimiter, authLimiter, heavyLimiter };
