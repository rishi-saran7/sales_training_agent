// ── Usage Tracker ────────────────────────────────────────────────────────────
// Lightweight in-memory usage statistics. Periodically flushed to Supabase
// if persistence is desired (opt-in via USAGE_PERSIST=true env var).
//
// Tracks per-user:
//   • Total calls started / completed
//   • STT minutes consumed
//   • LLM requests made
//   • TTS requests made
//
// Also tracks global counters for health-check / dashboard use.

const log = require('./logger');

class UsageTracker {
  constructor() {
    /** @type {Map<string, {calls: number, completed: number, sttMinutes: number, llmRequests: number, ttsRequests: number}>} */
    this._users = new Map();
    this._global = { calls: 0, completed: 0, sttMinutes: 0, llmRequests: 0, ttsRequests: 0, errors: 0 };
    this._startedAt = Date.now();
  }

  _ensure(userId) {
    if (!this._users.has(userId)) {
      this._users.set(userId, { calls: 0, completed: 0, sttMinutes: 0, llmRequests: 0, ttsRequests: 0 });
    }
    return this._users.get(userId);
  }

  /** Call started */
  trackCallStart(userId) {
    this._ensure(userId).calls++;
    this._global.calls++;
  }

  /** Call completed successfully */
  trackCallEnd(userId) {
    this._ensure(userId).completed++;
    this._global.completed++;
  }

  /** Track STT audio duration in seconds */
  trackSTT(userId, durationSec) {
    const mins = durationSec / 60;
    this._ensure(userId).sttMinutes += mins;
    this._global.sttMinutes += mins;
  }

  /** Track an LLM request */
  trackLLM(userId) {
    this._ensure(userId).llmRequests++;
    this._global.llmRequests++;
  }

  /** Track a TTS request */
  trackTTS(userId) {
    this._ensure(userId).ttsRequests++;
    this._global.ttsRequests++;
  }

  /** Track a pipeline error */
  trackError() {
    this._global.errors++;
  }

  /** Get stats for a specific user */
  getUserStats(userId) {
    return this._users.get(userId) || { calls: 0, completed: 0, sttMinutes: 0, llmRequests: 0, ttsRequests: 0 };
  }

  /** Get global stats (for health check / admin dashboard) */
  getGlobalStats() {
    return {
      ...this._global,
      sttMinutes: Math.round(this._global.sttMinutes * 100) / 100,
      activeUsers: this._users.size,
      uptimeSeconds: Math.round((Date.now() - this._startedAt) / 1000),
    };
  }

  /** Reset (useful for tests) */
  reset() {
    this._users.clear();
    Object.keys(this._global).forEach(k => this._global[k] = 0);
    this._startedAt = Date.now();
  }
}

module.exports = new UsageTracker();
