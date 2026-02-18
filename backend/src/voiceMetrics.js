/**
 * Voice Intelligence Metrics Engine
 *
 * Computes audio-derived performance metrics from timing data, speech
 * segments, and STT confidence.  No raw audio is stored.  All computation
 * uses lightweight heuristics – no ML models.
 *
 * TODO: Advanced acoustic modeling (pitch, intonation analysis)
 * TODO: Real emotion detection models (wav2vec, HuBERT)
 * TODO: ML-based voice scoring (trained on sales call corpora)
 */

'use strict';

// ── Hesitation / filler detection (applied on STT text) ─────────────────────
const HESITATION_REGEX = /\b(um|uh|uhh|umm|hmm|hm|er|erm|ah|ahh)\b/gi;

// ── Speaking-rate classification thresholds (words per minute) ───────────────
const PACE_SLOW = 100;   // Below = too slow
const PACE_IDEAL_LO = 120;
const PACE_IDEAL_HI = 160;
const PACE_FAST = 180;   // Above = too fast

/**
 * Compute voice / audio intelligence metrics at end-of-call.
 *
 * Inputs are lightweight timing arrays collected non-blockingly during the
 * call (no raw audio stored).
 *
 * @param {Object} params
 * @param {Array<{startMs: number, endMs: number, samples: number, sampleRate: number}>} params.speakingSegments
 *   One entry per USER_AUDIO_START→USER_AUDIO_END span.
 * @param {Array<{text: string, timestamp: number, confidence: number|null}>} params.sttEvents
 *   One entry per stt.final received during the call.
 * @param {number} params.callDurationMs – total call wall-clock duration.
 * @param {number} params.interruptionCount – barge-in count (already counted).
 * @param {Array<{role: string, timestamp: number}>} params.turnTimestamps
 * @param {number} params.totalUserWords – from conversation metrics (avoids re-counting).
 * @returns {Object} audio_metrics
 */
function computeVoiceMetrics({
  speakingSegments,
  sttEvents,
  callDurationMs,
  interruptionCount,
  turnTimestamps,
  totalUserWords,
}) {
  const segments = speakingSegments || [];
  const events = sttEvents || [];

  // ── Total user speaking time (from audio sample count) ────────
  let totalSpeakingMs = 0;
  for (const seg of segments) {
    if (seg.sampleRate && seg.samples > 0) {
      totalSpeakingMs += (seg.samples / seg.sampleRate) * 1000;
    } else if (seg.endMs && seg.startMs) {
      totalSpeakingMs += seg.endMs - seg.startMs;
    }
  }
  totalSpeakingMs = Math.round(totalSpeakingMs);

  // ── Total silence (call duration minus trainee speaking minus rough agent TTS) ──
  // We approximate: silent gaps = gaps between consecutive speaking segments.
  let totalSilenceMs = 0;
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].startMs - sorted[i - 1].endMs;
    if (gap > 0) totalSilenceMs += gap;
  }
  totalSilenceMs = Math.round(totalSilenceMs);

  // Average pause between segments.
  const pauseCount = sorted.length > 1 ? sorted.length - 1 : 0;
  const avgPauseDurationMs = pauseCount > 0 ? Math.round(totalSilenceMs / pauseCount) : 0;

  // ── Speaking rate (words per minute, based on audio duration) ──
  const speakingMin = totalSpeakingMs / 60000;
  const words = totalUserWords || 0;
  const speakingRateWpm = speakingMin > 0 ? Math.round(words / speakingMin) : 0;

  // ── Hesitation count (from STT text) ──────────────────────────
  let hesitationCount = 0;
  for (const ev of events) {
    const matches = (ev.text || '').match(HESITATION_REGEX);
    if (matches) hesitationCount += matches.length;
  }
  const hesitationRate = words > 0 ? Number(((hesitationCount / words) * 100).toFixed(1)) : 0;

  // ── STT confidence average (Deepgram word-level confidence) ───
  const confidenceValues = events
    .filter((ev) => ev.confidence != null && ev.confidence > 0)
    .map((ev) => ev.confidence);
  const avgSttConfidence = confidenceValues.length > 0
    ? Number((confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length).toFixed(3))
    : null;

  // ── Response latency (user→assistant transitions) ─────────────
  const stamps = turnTimestamps || [];
  const latencies = [];
  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i - 1].role === 'user' && stamps[i].role === 'assistant') {
      const lat = stamps[i].timestamp - stamps[i - 1].timestamp;
      if (lat > 0 && lat < 120000) latencies.push(lat);
    }
  }
  const avgResponseLatencyMs = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  // ── Composite scores (0-10, heuristic) ────────────────────────
  const confidenceProxy = computeConfidenceProxy({
    hesitationRate,
    speakingRateWpm,
    avgPauseDurationMs,
    interruptionCount,
    avgSttConfidence,
  });

  const vocalClarity = computeVocalClarity({
    avgSttConfidence,
    hesitationRate,
    speakingRateWpm,
  });

  const energyScore = computeEnergyScore({
    speakingRateWpm,
    totalSpeakingMs,
    callDurationMs,
    words,
    segments,
  });

  // ── Pace classification ───────────────────────────────────────
  let paceLabel = 'normal';
  if (speakingRateWpm > 0) {
    if (speakingRateWpm < PACE_SLOW) paceLabel = 'very_slow';
    else if (speakingRateWpm < PACE_IDEAL_LO) paceLabel = 'slow';
    else if (speakingRateWpm <= PACE_IDEAL_HI) paceLabel = 'ideal';
    else if (speakingRateWpm <= PACE_FAST) paceLabel = 'fast';
    else paceLabel = 'very_fast';
  }

  return {
    speaking_duration_ms: totalSpeakingMs,
    silence_duration_ms: totalSilenceMs,
    avg_pause_ms: avgPauseDurationMs,
    speaking_rate_wpm: speakingRateWpm,
    pace_label: paceLabel,
    hesitation_count: hesitationCount,
    hesitation_rate: hesitationRate,
    avg_stt_confidence: avgSttConfidence,
    avg_response_latency_ms: avgResponseLatencyMs,
    interruption_count: interruptionCount || 0,
    confidence_score: confidenceProxy,
    vocal_clarity_score: vocalClarity,
    energy_score: energyScore,
    segment_count: segments.length,
  };
}

/**
 * Confidence proxy (0-10).
 * High hesitation, erratic pace, long pauses → low confidence.
 */
function computeConfidenceProxy({ hesitationRate, speakingRateWpm, avgPauseDurationMs, interruptionCount, avgSttConfidence }) {
  let score = 6; // baseline

  // Hesitation penalty
  if (hesitationRate > 5) score -= 2;
  else if (hesitationRate > 3) score -= 1;
  else if (hesitationRate < 1) score += 1;

  // Pace: too slow signals uncertainty, too fast signals nervousness
  if (speakingRateWpm >= PACE_IDEAL_LO && speakingRateWpm <= PACE_IDEAL_HI) {
    score += 1.5;
  } else if (speakingRateWpm < PACE_SLOW || speakingRateWpm > PACE_FAST) {
    score -= 1;
  }

  // Long pauses signal hesitancy
  if (avgPauseDurationMs > 5000) score -= 1.5;
  else if (avgPauseDurationMs > 3000) score -= 0.5;
  else if (avgPauseDurationMs < 2000 && avgPauseDurationMs > 0) score += 0.5;

  // STT confidence enrichment (if Deepgram provides word-level confidence)
  if (avgSttConfidence != null) {
    if (avgSttConfidence > 0.92) score += 1;
    else if (avgSttConfidence < 0.7) score -= 1;
  }

  // Interruptions: excessive = nervous or aggressive
  if (interruptionCount > 5) score -= 1;
  else if (interruptionCount > 2) score -= 0.5;

  return Number(Math.max(0, Math.min(10, score)).toFixed(1));
}

/**
 * Vocal clarity score (0-10).
 * Clear speech → high STT confidence, low hesitation, moderate pace.
 */
function computeVocalClarity({ avgSttConfidence, hesitationRate, speakingRateWpm }) {
  let score = 5;

  if (avgSttConfidence != null) {
    // Map STT confidence (typically 0.7-1.0 range) to a boost
    if (avgSttConfidence > 0.95) score += 2.5;
    else if (avgSttConfidence > 0.9) score += 1.5;
    else if (avgSttConfidence > 0.8) score += 0.5;
    else if (avgSttConfidence < 0.6) score -= 2;
    else if (avgSttConfidence < 0.7) score -= 1;
  } else {
    // Without STT confidence, rely more on other signals
    score += 1; // neutral assumption
  }

  // Hesitation hurts clarity
  if (hesitationRate > 5) score -= 2;
  else if (hesitationRate > 3) score -= 1;
  else if (hesitationRate < 1) score += 1;

  // Too fast = hard to follow, too slow = unclear delivery
  if (speakingRateWpm >= PACE_IDEAL_LO && speakingRateWpm <= PACE_IDEAL_HI) {
    score += 1;
  } else if (speakingRateWpm > PACE_FAST) {
    score -= 1;
  }

  return Number(Math.max(0, Math.min(10, score)).toFixed(1));
}

/**
 * Engagement energy score (0-10).
 * Based on speaking time share, pace, word output.
 */
function computeEnergyScore({ speakingRateWpm, totalSpeakingMs, callDurationMs, words, segments }) {
  let score = 5;

  // Speaking time as proportion of call
  const speakingRatio = callDurationMs > 0 ? totalSpeakingMs / callDurationMs : 0;
  if (speakingRatio >= 0.2 && speakingRatio <= 0.6) score += 1;
  else if (speakingRatio < 0.1) score -= 1.5;
  else if (speakingRatio > 0.7) score -= 0.5;

  // Active pace indicates energy
  if (speakingRateWpm >= PACE_IDEAL_LO && speakingRateWpm <= PACE_IDEAL_HI) {
    score += 1.5;
  } else if (speakingRateWpm >= PACE_SLOW && speakingRateWpm <= PACE_FAST) {
    score += 0.5;
  } else if (speakingRateWpm < PACE_SLOW && speakingRateWpm > 0) {
    score -= 1;
  }

  // Word output signals engagement
  if (words > 100) score += 1;
  else if (words > 50) score += 0.5;
  else if (words < 20 && words > 0) score -= 1;

  // Multiple speaking segments = sustained engagement
  const segCount = (segments || []).length;
  if (segCount >= 4) score += 0.5;
  else if (segCount <= 1 && words > 0) score -= 0.5;

  return Number(Math.max(0, Math.min(10, score)).toFixed(1));
}

/**
 * Aggregate voice metrics across sessions for analytics dashboards.
 *
 * @param {Array<Object>} metricsList – array of audio_metrics objects
 * @returns {Object|null} aggregated averages
 */
function aggregateVoiceMetrics(metricsList) {
  if (!metricsList || metricsList.length === 0) return null;

  const count = metricsList.length;
  const sums = {
    speaking_duration_ms: 0,
    silence_duration_ms: 0,
    avg_pause_ms: 0,
    speaking_rate_wpm: 0,
    hesitation_count: 0,
    hesitation_rate: 0,
    interruption_count: 0,
    confidence_score: 0,
    vocal_clarity_score: 0,
    energy_score: 0,
  };
  let sttConfSum = 0;
  let sttConfCount = 0;
  let latencySum = 0;
  let latencyCount = 0;

  const paceCounts = { very_slow: 0, slow: 0, ideal: 0, fast: 0, very_fast: 0, normal: 0 };

  for (const m of metricsList) {
    if (!m) continue;
    sums.speaking_duration_ms += m.speaking_duration_ms || 0;
    sums.silence_duration_ms += m.silence_duration_ms || 0;
    sums.avg_pause_ms += m.avg_pause_ms || 0;
    sums.speaking_rate_wpm += m.speaking_rate_wpm || 0;
    sums.hesitation_count += m.hesitation_count || 0;
    sums.hesitation_rate += m.hesitation_rate || 0;
    sums.interruption_count += m.interruption_count || 0;
    sums.confidence_score += m.confidence_score || 0;
    sums.vocal_clarity_score += m.vocal_clarity_score || 0;
    sums.energy_score += m.energy_score || 0;

    if (m.avg_stt_confidence != null) {
      sttConfSum += m.avg_stt_confidence;
      sttConfCount++;
    }
    if (m.avg_response_latency_ms != null) {
      latencySum += m.avg_response_latency_ms;
      latencyCount++;
    }
    if (m.pace_label && paceCounts[m.pace_label] !== undefined) {
      paceCounts[m.pace_label]++;
    }
  }

  // Determine most common pace
  let dominantPace = 'normal';
  let maxPaceCount = 0;
  for (const [pace, cnt] of Object.entries(paceCounts)) {
    if (cnt > maxPaceCount) {
      maxPaceCount = cnt;
      dominantPace = pace;
    }
  }

  return {
    avg_speaking_duration_ms: Math.round(sums.speaking_duration_ms / count),
    avg_silence_duration_ms: Math.round(sums.silence_duration_ms / count),
    avg_pause_ms: Math.round(sums.avg_pause_ms / count),
    avg_speaking_rate_wpm: Math.round(sums.speaking_rate_wpm / count),
    avg_hesitation_count: Number((sums.hesitation_count / count).toFixed(1)),
    avg_hesitation_rate: Number((sums.hesitation_rate / count).toFixed(1)),
    avg_interruption_count: Number((sums.interruption_count / count).toFixed(1)),
    avg_confidence_score: Number((sums.confidence_score / count).toFixed(1)),
    avg_vocal_clarity_score: Number((sums.vocal_clarity_score / count).toFixed(1)),
    avg_energy_score: Number((sums.energy_score / count).toFixed(1)),
    avg_stt_confidence: sttConfCount > 0 ? Number((sttConfSum / sttConfCount).toFixed(3)) : null,
    avg_response_latency_ms: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
    dominant_pace: dominantPace,
    total_sessions: count,
  };
}

module.exports = { computeVoiceMetrics, aggregateVoiceMetrics };
