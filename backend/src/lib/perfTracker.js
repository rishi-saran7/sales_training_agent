// ── Performance Tracker ──────────────────────────────────────────────────────
// Measures latency for STT, LLM, and TTS operations and exposes summary stats.
// All timings are in milliseconds.
//
// Usage:
//   const perf = require('./lib/perfTracker');
//   const end = perf.start('llm');
//   await doLlmCall();
//   end();                     // records the timing
//   perf.getSummary();         // { llm: { count, avg, min, max, p95 }, ... }
//
// TODO: Add metrics dashboard integration (Prometheus, Grafana).
// TODO: Add alerting system for latency spikes.
// TODO: Add autoscaling triggers based on queue depth / latency.

const log = require('./logger');

const BUCKETS = ['stt', 'llm', 'tts', 'feedback'];

class PerfTracker {
  constructor() {
    /** @type {Record<string, number[]>} */
    this._timings = {};
    for (const b of BUCKETS) this._timings[b] = [];
    this._maxHistory = 500; // Keep last N samples per bucket.
  }

  /**
   * Start a timer for the given bucket.
   * Returns a function you call when the operation is done; it logs + records the duration.
   * @param {string} bucket  One of BUCKETS.
   * @param {object} [meta]  Extra fields to include in the log line (sessionId, userId, etc.)
   * @returns {() => number}  Stopper function that returns elapsed ms.
   */
  start(bucket, meta = {}) {
    const t0 = performance.now();
    return () => {
      const elapsed = Math.round(performance.now() - t0);
      this._record(bucket, elapsed, meta);
      return elapsed;
    };
  }

  /** Record a timing directly (e.g. when the timer was managed externally). */
  record(bucket, ms, meta = {}) {
    this._record(bucket, ms, meta);
  }

  _record(bucket, ms, meta) {
    if (!this._timings[bucket]) this._timings[bucket] = [];
    const arr = this._timings[bucket];
    arr.push(ms);
    if (arr.length > this._maxHistory) arr.shift();
    log.debug({ bucket, ms, ...meta }, `perf:${bucket}`);
  }

  /**
   * Return aggregate statistics per bucket.
   * @returns {Record<string, {count: number, avg: number, min: number, max: number, p95: number, last: number}>}
   */
  getSummary() {
    const summary = {};
    for (const [bucket, timings] of Object.entries(this._timings)) {
      if (timings.length === 0) {
        summary[bucket] = { count: 0, avg: 0, min: 0, max: 0, p95: 0, last: 0 };
        continue;
      }
      const sorted = [...timings].sort((a, b) => a - b);
      const count = sorted.length;
      const sum = sorted.reduce((a, b) => a + b, 0);
      const p95Idx = Math.min(Math.floor(count * 0.95), count - 1);
      summary[bucket] = {
        count,
        avg: Math.round(sum / count),
        min: sorted[0],
        max: sorted[count - 1],
        p95: sorted[p95Idx],
        last: sorted[count - 1],
      };
    }
    return summary;
  }

  /** Reset all recorded timings. */
  reset() {
    for (const b of Object.keys(this._timings)) this._timings[b] = [];
  }
}

// Export a singleton so all modules share the same tracker.
module.exports = new PerfTracker();
