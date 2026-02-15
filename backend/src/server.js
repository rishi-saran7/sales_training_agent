require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { setupWebsocket } = require('./websocket');
const { supabase } = require('./lib/supabase');

// Use a fixed port so the frontend knows where to connect during local development.
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

const app = express();

// Allow the Next.js dev server to reach this API. Adjust origins when deploying.
app.use(cors({ origin: 'http://localhost:3000' }));

async function requireUser(req, res) {
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured' });
    return null;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Missing auth token' });
    return null;
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({ error: 'Invalid auth token' });
      return null;
    }
    return data.user;
  } catch (err) {
    res.status(401).json({ error: 'Invalid auth token' });
    return null;
  }
}

// Lightweight health check so we can quickly verify the HTTP layer is alive.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// TODO: Add authentication + RLS enforcement for session access.
// TODO: Add pagination support for session history.
app.get('/api/sessions', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const { data, error } = await supabase
      .from('call_sessions')
      .select('id, scenario, call_duration, overall_score:feedback->>overall_score, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[supabase] Failed to fetch sessions:', error.message || error);
      res.status(500).json({ error: 'Failed to fetch sessions' });
      return;
    }

    res.json({ sessions: data || [] });
  } catch (err) {
    console.error('[supabase] Failed to fetch sessions:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// TODO: Add multi-user filtering for analytics.
// TODO: Add trainer dashboard aggregation layer.
// TODO: Add export reports (PDF/CSV).
app.get('/api/analytics', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const { data, error } = await supabase
      .from('call_sessions')
      .select(
        'scenario, created_at, overall_score:feedback->>overall_score, objection_handling:feedback->>objection_handling, communication_clarity:feedback->>communication_clarity, confidence:feedback->>confidence'
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) {
      console.error('[supabase] Failed to fetch analytics:', error.message || error);
      res.status(500).json({ error: 'Failed to fetch analytics' });
      return;
    }

    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      res.json({
        summary: {
          totalSessions: 0,
          avgOverallScore: 0,
          avgObjectionHandling: 0,
          avgCommunicationClarity: 0,
          avgConfidence: 0,
          bestScore: 0,
          worstScore: 0,
        },
        trend: [],
        byScenario: [],
      });
      return;
    }

    const toNumber = (value) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };

    const totals = {
      overall: 0,
      objection: 0,
      clarity: 0,
      confidence: 0,
      count: 0,
      best: null,
      worst: null,
    };

    const scenarioBuckets = new Map();
    const trend = [];

    for (const row of rows) {
      const overall = toNumber(row.overall_score);
      const objection = toNumber(row.objection_handling);
      const clarity = toNumber(row.communication_clarity);
      const confidence = toNumber(row.confidence);
      const scenario = row.scenario || 'Unknown';

      if (overall !== null) {
        totals.overall += overall;
        totals.count += 1;
        totals.best = totals.best === null ? overall : Math.max(totals.best, overall);
        totals.worst = totals.worst === null ? overall : Math.min(totals.worst, overall);
      }
      if (objection !== null) totals.objection += objection;
      if (clarity !== null) totals.clarity += clarity;
      if (confidence !== null) totals.confidence += confidence;

      trend.push({
        created_at: row.created_at,
        overall_score: overall,
      });

      if (!scenarioBuckets.has(scenario)) {
        scenarioBuckets.set(scenario, {
          scenario,
          totalOverall: 0,
          count: 0,
        });
      }
      const bucket = scenarioBuckets.get(scenario);
      if (overall !== null) {
        bucket.totalOverall += overall;
        bucket.count += 1;
      }
    }

    const byScenario = Array.from(scenarioBuckets.values()).map((bucket) => ({
      scenario: bucket.scenario,
      avgOverallScore: bucket.count > 0 ? bucket.totalOverall / bucket.count : 0,
      count: bucket.count,
    }));

    res.json({
      summary: {
        totalSessions: totals.count,
        avgOverallScore: totals.count > 0 ? totals.overall / totals.count : 0,
        avgObjectionHandling: totals.count > 0 ? totals.objection / totals.count : 0,
        avgCommunicationClarity: totals.count > 0 ? totals.clarity / totals.count : 0,
        avgConfidence: totals.count > 0 ? totals.confidence / totals.count : 0,
        bestScore: totals.best ?? 0,
        worstScore: totals.worst ?? 0,
      },
      trend,
      byScenario,
    });
  } catch (err) {
    console.error('[supabase] Failed to fetch analytics:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

const server = http.createServer(app);

// Attach the WebSocket server to the same HTTP server so both share port 3001.
setupWebsocket(server);

server.listen(PORT, () => {
  console.log(`[http] Listening on http://localhost:${PORT}`);
});
