/**
 * Conversation Intelligence Metrics Engine
 *
 * Computes deterministic, programmatic metrics from call transcripts and
 * timing data.  No LLM calls – everything is regex / string-match / arithmetic.
 *
 * All public functions accept plain JS objects and return plain JS objects so
 * the module stays stateless and easy to test.
 */

'use strict';

// ── Regex dictionaries ──────────────────────────────────────────────────────

const QUESTION_STARTERS = /^(who|what|when|where|why|how|is|are|do|does|did|can|could|would|will|shall|should|have|has|had|may|might)\b/i;

const FILLER_WORDS = /\b(um|uh|uhh|umm|hmm|hm|like|you know|i mean|basically|actually|literally|sort of|kind of|right|okay so|so yeah)\b/gi;

const OBJECTION_KEYWORDS = /\b(too expensive|too costly|can't afford|budget|out of budget|over budget|not worth|not interested|no need|don't need|already have|competitor|cheaper|better option|think about it|not sure|need to discuss|talk to my|check with|come back later|not the right time|not a priority|too risky|concerned about)\b/i;

const PRICING_KEYWORDS = /\b(price|pricing|cost|costs|discount|discounts|deal|fee|fees|rate|rates|quote|budget|investment|pay|payment|affordable|economical|value|roi|return on investment|money|dollar|dollars|subscription|plan|tier|package)\b/i;

const COMPETITOR_KEYWORDS = /\b(competitor|competitors|competition|alternative|alternatives|other vendor|other vendors|other option|other options|another provider|another company|switch|switching|salesforce|hubspot|zoho|pipedrive|microsoft|oracle|sap|zendesk|freshworks|outreach|gong|chorus)\b/i;

const CLOSING_KEYWORDS = /\b(sign up|sign on|get started|move forward|next step|next steps|close the deal|close deal|let's do it|i'm in|let's go|start today|agreement|contract|proposal|onboard|implement|purchase|buy|order)\b/i;

const RAPPORT_KEYWORDS = /\b(thank you|thanks|appreciate|great question|good point|i understand|absolutely|of course|happy to|glad to|pleasure|nice to|wonderful|fantastic|excellent|i hear you|makes sense|fair enough)\b/i;

// ── Helper utilities ────────────────────────────────────────────────────────

function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countMatches(text, regex) {
  if (!text) return 0;
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function containsQuestion(text) {
  if (!text) return false;
  // Contains a question mark or starts with a question word
  if (text.includes('?')) return true;
  // Check each sentence for question starters
  const sentences = text.split(/[.!?]+/).filter(Boolean);
  return sentences.some((s) => QUESTION_STARTERS.test(s.trim()));
}

function extractSentences(text) {
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Core metric computations ────────────────────────────────────────────────

/**
 * Compute all conversation intelligence metrics.
 *
 * @param {Object} params
 * @param {Array<{role: string, content: string}>} params.conversation  – full conversation array (includes system message at index 0)
 * @param {number} params.callDurationMs – total call duration in milliseconds
 * @param {number} params.interruptionCount – number of barge-in interruptions detected
 * @param {Array<{role: string, timestamp: number}>} params.turnTimestamps – per-turn timing (role + epoch ms)
 * @returns {Object} conversation_metrics
 */
function computeMetrics({ conversation, callDurationMs, interruptionCount, turnTimestamps }) {
  // Filter out the system prompt; work only with actual dialogue turns.
  const turns = (conversation || []).filter((msg) => msg.role !== 'system');

  const userTurns = turns.filter((t) => t.role === 'user');
  const assistantTurns = turns.filter((t) => t.role === 'assistant');

  // ── Talk Ratio ────────────────────────────────────────────────
  const userWords = userTurns.reduce((sum, t) => sum + wordCount(t.content), 0);
  const assistantWords = assistantTurns.reduce((sum, t) => sum + wordCount(t.content), 0);
  const totalWords = userWords + assistantWords;
  const talkRatio = totalWords > 0 ? Number((userWords / totalWords).toFixed(3)) : 0;

  // ── Question Metrics ──────────────────────────────────────────
  const userQuestions = userTurns.filter((t) => containsQuestion(t.content)).length;
  const assistantQuestions = assistantTurns.filter((t) => containsQuestion(t.content)).length;

  // ── Filler Words ──────────────────────────────────────────────
  const userText = userTurns.map((t) => t.content).join(' ');
  const fillerWordCount = countMatches(userText, FILLER_WORDS);
  const fillerWordRate = userWords > 0 ? Number((fillerWordCount / userWords * 100).toFixed(1)) : 0;

  // ── Turn Length Distribution (user only) ──────────────────────
  const userTurnLengths = userTurns.map((t) => wordCount(t.content));
  const avgTurnLength = userTurnLengths.length > 0
    ? Number((userTurnLengths.reduce((a, b) => a + b, 0) / userTurnLengths.length).toFixed(1))
    : 0;
  const longestMonologue = userTurnLengths.length > 0 ? Math.max(...userTurnLengths) : 0;

  // ── Topic Detection (across ALL user turns) ───────────────────
  const objectionDetected = OBJECTION_KEYWORDS.test(userText);
  const pricingDiscussed = PRICING_KEYWORDS.test(userText);
  const competitorMentioned = COMPETITOR_KEYWORDS.test(userText);
  const closingAttempted = CLOSING_KEYWORDS.test(userText);
  const rapportPhrases = countMatches(userText, RAPPORT_KEYWORDS);

  // Also check assistant turns for topics the *customer* raised
  const customerText = assistantTurns.map((t) => t.content).join(' ');
  const customerObjections = OBJECTION_KEYWORDS.test(customerText);
  const customerPricingRaised = PRICING_KEYWORDS.test(customerText);
  const customerCompetitorMentioned = COMPETITOR_KEYWORDS.test(customerText);

  // ── Response Latency (from turn timestamps) ───────────────────
  const stamps = turnTimestamps || [];
  const latencies = [];
  for (let i = 1; i < stamps.length; i++) {
    // User → Assistant transition = response latency
    if (stamps[i - 1].role === 'user' && stamps[i].role === 'assistant') {
      const latency = stamps[i].timestamp - stamps[i - 1].timestamp;
      if (latency > 0 && latency < 120000) {
        latencies.push(latency);
      }
    }
  }
  const avgResponseLatencyMs = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  // ── Engagement Score (composite 0-10) ─────────────────────────
  const engagement = computeEngagementScore({
    talkRatio,
    userQuestions,
    totalUserTurns: userTurns.length,
    rapportPhrases,
    fillerWordRate,
    closingAttempted,
    avgTurnLength,
    interruptionCount,
  });

  // ── Pace (words per minute, user) ─────────────────────────────
  const callDurationMin = callDurationMs / 60000;
  const userWordsPerMinute = callDurationMin > 0
    ? Math.round(userWords / callDurationMin)
    : 0;

  return {
    talk_ratio: talkRatio,
    user_word_count: userWords,
    agent_word_count: assistantWords,
    user_turn_count: userTurns.length,
    agent_turn_count: assistantTurns.length,
    user_questions_asked: userQuestions,
    customer_questions_asked: assistantQuestions,
    filler_word_count: fillerWordCount,
    filler_word_rate: fillerWordRate,
    avg_turn_length: avgTurnLength,
    longest_monologue: longestMonologue,
    interruption_count: interruptionCount || 0,
    avg_response_latency_ms: avgResponseLatencyMs,
    user_words_per_minute: userWordsPerMinute,
    engagement_score: engagement,
    objection_detected: objectionDetected,
    customer_raised_objection: customerObjections,
    pricing_discussed: pricingDiscussed,
    customer_raised_pricing: customerPricingRaised,
    competitor_mentioned: competitorMentioned,
    customer_mentioned_competitor: customerCompetitorMentioned,
    closing_attempted: closingAttempted,
    rapport_building_phrases: rapportPhrases,
  };
}

/**
 * Composite engagement score (0-10) based on multiple conversation signals.
 */
function computeEngagementScore({
  talkRatio,
  userQuestions,
  totalUserTurns,
  rapportPhrases,
  fillerWordRate,
  closingAttempted,
  avgTurnLength,
  interruptionCount,
}) {
  let score = 5; // baseline

  // Talk ratio: ideal is ~40-60% (the trainee should talk but also listen)
  if (talkRatio >= 0.35 && talkRatio <= 0.65) {
    score += 1;
  } else if (talkRatio < 0.2 || talkRatio > 0.8) {
    score -= 1;
  }

  // Questions indicate active discovery
  const questionRate = totalUserTurns > 0 ? userQuestions / totalUserTurns : 0;
  if (questionRate >= 0.25) score += 1.5;
  else if (questionRate >= 0.1) score += 0.75;

  // Rapport-building language
  if (rapportPhrases >= 3) score += 1;
  else if (rapportPhrases >= 1) score += 0.5;

  // Filler words penalize (excessive indicates nervousness)
  if (fillerWordRate > 5) score -= 1;
  else if (fillerWordRate > 3) score -= 0.5;

  // Closing attempt is positive
  if (closingAttempted) score += 0.5;

  // Turn length: too short = low effort, too long = monologuing
  if (avgTurnLength >= 10 && avgTurnLength <= 50) score += 0.5;
  else if (avgTurnLength > 80) score -= 0.5;

  // Interruptions: occasional is fine, excessive is bad
  if (interruptionCount > 5) score -= 1;
  else if (interruptionCount > 2) score -= 0.5;

  // Clamp to 0-10
  return Number(Math.max(0, Math.min(10, score)).toFixed(1));
}

/**
 * Aggregate conversation_metrics across multiple sessions for analytics views.
 *
 * @param {Array<Object>} metricsList – array of conversation_metrics objects
 * @returns {Object} aggregated averages
 */
function aggregateMetrics(metricsList) {
  if (!metricsList || metricsList.length === 0) {
    return null;
  }

  const count = metricsList.length;
  const sums = {
    talk_ratio: 0,
    user_questions_asked: 0,
    customer_questions_asked: 0,
    filler_word_count: 0,
    filler_word_rate: 0,
    avg_turn_length: 0,
    longest_monologue: 0,
    interruption_count: 0,
    engagement_score: 0,
    user_words_per_minute: 0,
    rapport_building_phrases: 0,
  };

  let latencySum = 0;
  let latencyCount = 0;
  let objectionSessions = 0;
  let pricingSessions = 0;
  let competitorSessions = 0;
  let closingSessions = 0;
  let customerObjectionSessions = 0;

  for (const m of metricsList) {
    if (!m) continue;
    sums.talk_ratio += m.talk_ratio || 0;
    sums.user_questions_asked += m.user_questions_asked || 0;
    sums.customer_questions_asked += m.customer_questions_asked || 0;
    sums.filler_word_count += m.filler_word_count || 0;
    sums.filler_word_rate += m.filler_word_rate || 0;
    sums.avg_turn_length += m.avg_turn_length || 0;
    sums.longest_monologue += m.longest_monologue || 0;
    sums.interruption_count += m.interruption_count || 0;
    sums.engagement_score += m.engagement_score || 0;
    sums.user_words_per_minute += m.user_words_per_minute || 0;
    sums.rapport_building_phrases += m.rapport_building_phrases || 0;

    if (m.avg_response_latency_ms != null) {
      latencySum += m.avg_response_latency_ms;
      latencyCount += 1;
    }
    if (m.objection_detected) objectionSessions++;
    if (m.pricing_discussed) pricingSessions++;
    if (m.competitor_mentioned) competitorSessions++;
    if (m.closing_attempted) closingSessions++;
    if (m.customer_raised_objection) customerObjectionSessions++;
  }

  return {
    avg_talk_ratio: Number((sums.talk_ratio / count).toFixed(3)),
    avg_user_questions: Number((sums.user_questions_asked / count).toFixed(1)),
    avg_customer_questions: Number((sums.customer_questions_asked / count).toFixed(1)),
    avg_filler_word_count: Number((sums.filler_word_count / count).toFixed(1)),
    avg_filler_word_rate: Number((sums.filler_word_rate / count).toFixed(1)),
    avg_turn_length: Number((sums.avg_turn_length / count).toFixed(1)),
    avg_longest_monologue: Number((sums.longest_monologue / count).toFixed(1)),
    avg_interruption_count: Number((sums.interruption_count / count).toFixed(1)),
    avg_engagement_score: Number((sums.engagement_score / count).toFixed(1)),
    avg_response_latency_ms: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
    avg_words_per_minute: Math.round(sums.user_words_per_minute / count),
    avg_rapport_phrases: Number((sums.rapport_building_phrases / count).toFixed(1)),
    objection_session_pct: Number(((objectionSessions / count) * 100).toFixed(0)),
    pricing_session_pct: Number(((pricingSessions / count) * 100).toFixed(0)),
    competitor_session_pct: Number(((competitorSessions / count) * 100).toFixed(0)),
    closing_session_pct: Number(((closingSessions / count) * 100).toFixed(0)),
    customer_objection_pct: Number(((customerObjectionSessions / count) * 100).toFixed(0)),
    total_sessions: count,
  };
}

module.exports = { computeMetrics, aggregateMetrics };
