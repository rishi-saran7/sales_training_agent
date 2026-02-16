require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const { setupWebsocket } = require('./websocket');
const { supabase } = require('./lib/supabase');

// Use a fixed port so the frontend knows where to connect during local development.
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

const app = express();

app.use(express.json());

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

// TODO: Add organization branding to PDF reports.
// TODO: Add trainer comments section to reports.
// TODO: Add batch export for multi-session reports.
// TODO: Add email delivery for completed reports.
// TODO: Add enterprise billing for organizations.
// TODO: Add org-level reporting exports.
// TODO: Add team performance export jobs.

async function getMembership(userId) {
  const { data, error } = await supabase
    .from('organization_members')
    .select('id, organization_id, role, organizations(name)')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data || null;
}

async function getAdmin(userId) {
  const { data, error } = await supabase
    .from('admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data || null;
}

async function getAdmins() {
  const { data, error } = await supabase
    .from('admins')
    .select('user_id');

  if (error) {
    throw error;
  }
  return Array.isArray(data) ? data : [];
}

async function getOrgMembers(orgId) {
  const { data, error } = await supabase
    .from('organization_members')
    .select('user_id, role')
    .eq('organization_id', orgId);

  if (error) {
    throw error;
  }

  return Array.isArray(data) ? data : [];
}

async function listUsers(perPage = 200) {
  if (!supabase?.auth?.admin) {
    throw new Error('Supabase admin API unavailable');
  }
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage });
  if (error) {
    throw error;
  }
  return data?.users || [];
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function coerceText(value) {
  return String(value || '').trim();
}

async function requireAdmin(userId, res) {
  const admin = await getAdmin(userId);
  if (!admin) {
    res.status(403).json({ error: 'Admin role required' });
    return null;
  }
  return admin;
}

async function requireTrainer(userId, res) {
  const membership = await getMembership(userId);
  if (!membership || membership.role !== 'trainer') {
    res.status(403).json({ error: 'Trainer role required' });
    return null;
  }
  console.log(`[org] Role detected: ${membership.role}`);
  return membership;
}

function formatDate(value) {
  const date = value ? new Date(value) : new Date();
  return date.toLocaleString();
}

function formatScore(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num}/10` : 'N/A';
}

function summarizeTranscript(transcript) {
  if (!transcript || typeof transcript !== 'string') {
    return 'Transcript summary unavailable.';
  }
  const lines = transcript
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return 'Transcript summary unavailable.';
  if (lines.length <= 5) return lines.join(' ');

  const intro = lines.slice(0, 3).join(' ');
  const outro = lines.slice(-2).join(' ');
  return `${intro} ... ${outro}`;
}

function coerceList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function addSectionTitle(doc, title) {
  doc.x = doc.page.margins.left;
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111111').text(title);
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(11).fillColor('#333333');
}

function addDivider(doc) {
  const y = doc.y + 4;
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).strokeColor('#e2e8f0').stroke();
  doc.moveDown(0.6);
  doc.strokeColor('#000000');
}

function addBulletList(doc, items) {
  if (!items || items.length === 0) return;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  items.forEach((item) => {
    doc.text(`• ${item}`, { indent: 10, width });
  });
}

function shortenLabel(text, maxLength) {
  const clean = String(text || '').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 3))}...`;
}

function ensureSpace(doc, height) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height > bottom) {
    doc.addPage();
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function drawBarChart(doc, items, options = {}) {
  const width = options.width || (doc.page.width - doc.page.margins.left - doc.page.margins.right);
  const height = options.height || 140;
  const barColor = options.barColor || '#1f6feb';
  const maxItems = options.maxItems || items.length;
  const labelSize = options.labelSize || 9;
  const valueSize = options.valueSize || 9;
  const gap = 8;

  const data = items.slice(0, maxItems);
  if (data.length === 0) return;

  ensureSpace(doc, height + 24);
  const startX = doc.page.margins.left;
  const startY = doc.y + 8;
  const labelWidth = 90;
  const valueWidth = 40;
  const barAreaWidth = width - labelWidth - valueWidth - 10;
  const maxValue = Math.max(...data.map((item) => item.value || 0), 1);
  const barHeight = Math.max(10, (height - (data.length - 1) * gap) / data.length);

  data.forEach((item, index) => {
    const y = startY + index * (barHeight + gap);
    const barWidth = Math.max(4, (barAreaWidth * item.value) / maxValue);
    const label = shortenLabel(item.label, 18);
    doc.fillColor('#334155').fontSize(labelSize).text(label, startX, y, { width: labelWidth });
    doc.fillColor(barColor).rect(startX + labelWidth + 10, y, barWidth, barHeight).fill();
    doc
      .fillColor('#334155')
      .fontSize(valueSize)
      .text(String(item.value), startX + labelWidth + 14 + barWidth, y, { width: valueWidth });
  });

  doc.y = startY + height + 14;
  doc.x = doc.page.margins.left;
}

function drawLineChart(doc, points, options = {}) {
  const width = options.width || (doc.page.width - doc.page.margins.left - doc.page.margins.right);
  const height = options.height || 150;
  const stroke = options.stroke || '#0ea5e9';
  const axisColor = options.axisColor || '#94a3b8';
  const padding = 24;
  const data = points.filter((point) => typeof point.value === 'number');
  if (data.length < 2) return;

  ensureSpace(doc, height + 20);
  const startX = doc.page.margins.left;
  const startY = doc.y + 8;
  const minValue = Math.min(...data.map((p) => p.value));
  const maxValue = Math.max(...data.map((p) => p.value));
  const range = Math.max(1, maxValue - minValue);
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;

  doc.strokeColor(axisColor).lineWidth(1);
  doc.moveTo(startX + padding, startY + padding).lineTo(startX + padding, startY + padding + chartHeight).stroke();
  doc.moveTo(startX + padding, startY + padding + chartHeight).lineTo(startX + padding + chartWidth, startY + padding + chartHeight).stroke();

  doc.strokeColor(stroke).lineWidth(2);
  data.forEach((point, index) => {
    const x = startX + padding + (index / (data.length - 1)) * chartWidth;
    const y = startY + padding + chartHeight - ((point.value - minValue) / range) * chartHeight;
    if (index === 0) {
      doc.moveTo(x, y);
    } else {
      doc.lineTo(x, y);
    }
  });
  doc.stroke();

  doc.fillColor('#64748b').fontSize(9);
  doc.text(`${minValue}`, startX + padding + chartWidth + 4, startY + padding + chartHeight - 8, { width: 40 });
  doc.text(`${maxValue}`, startX + padding + chartWidth + 4, startY + padding - 6, { width: 40 });

  doc.y = startY + height + 14;
  doc.x = doc.page.margins.left;
}

function roundScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 10) / 10;
}

function summarizeScoreLabel(value) {
  if (value === null) return 'No score recorded.';
  if (value < 5) return 'Needs focused improvement.';
  if (value < 7.5) return 'Solid foundation with room to grow.';
  return 'Strong performance at an advanced level.';
}

function buildSessionInsights(feedback) {
  const overall = roundScore(feedback.overall_score);
  const objection = roundScore(feedback.objection_handling);
  const clarity = roundScore(feedback.communication_clarity);
  const confidence = roundScore(feedback.confidence);

  return [
    `Overall: ${summarizeScoreLabel(overall)}`,
    `Objection Handling: ${summarizeScoreLabel(objection)}`,
    `Communication Clarity: ${summarizeScoreLabel(clarity)}`,
    `Confidence: ${summarizeScoreLabel(confidence)}`,
  ];
}

function tallyListItems(rows, field) {
  const counts = new Map();
  rows.forEach((row) => {
    const list = coerceList(row?.feedback?.[field]);
    list.forEach((item) => {
      const key = String(item).trim();
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([text, count]) => `${text} (${count}x)`);
}

function tallyListCounts(rows, field) {
  const counts = new Map();
  rows.forEach((row) => {
    const list = coerceList(row?.feedback?.[field]);
    list.forEach((item) => {
      const key = String(item).trim();
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([text, count]) => ({ label: text, value: count }));
}

function computeTrendDelta(rows) {
  if (!rows || rows.length < 4) return null;
  const scores = rows
    .map((row) => toNumber(row.overall_score))
    .filter((value) => value !== null);
  if (scores.length < 4) return null;

  const recent = scores.slice(-3);
  const previous = scores.slice(-6, -3);
  if (recent.length === 0 || previous.length === 0) return null;

  const avg = (list) => list.reduce((sum, val) => sum + val, 0) / list.length;
  return roundScore(avg(recent) - avg(previous));
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function fetchAnalyticsData(userIds) {
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  if (ids.length === 0) {
    return {
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
      range: null,
    };
  }

  const { data, error } = await supabase
    .from('call_sessions')
    .select(
      'scenario, created_at, overall_score:feedback->>overall_score, objection_handling:feedback->>objection_handling, communication_clarity:feedback->>communication_clarity, confidence:feedback->>confidence'
    )
    .in('user_id', ids)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) {
    throw error;
  }

  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) {
    return {
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
      range: null,
    };
  }

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

  return {
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
    range: {
      start: rows[0]?.created_at || null,
      end: rows[rows.length - 1]?.created_at || null,
    },
  };
}

app.post('/api/org/bootstrap', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;

    const existing = await getMembership(user.id);
    if (existing) {
      res.json({
        organizationId: existing.organization_id,
        organizationName: existing.organizations?.name || 'Organization',
        role: existing.role,
      });
      return;
    }

    const orgName = `Team ${user.email ? user.email.split('@')[0] : 'Trainer'}`;
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .insert({ name: orgName })
      .select('id, name')
      .single();

    if (orgError || !org) {
      console.error('[org] Failed to create organization:', orgError?.message || orgError);
      res.status(500).json({ error: 'Failed to create organization' });
      return;
    }

    const { error: memberError } = await supabase
      .from('organization_members')
      .insert({ organization_id: org.id, user_id: user.id, role: 'trainer' });

    if (memberError) {
      console.error('[org] Failed to add trainer membership:', memberError.message || memberError);
      res.status(500).json({ error: 'Failed to add organization member' });
      return;
    }

    console.log(`[org] Org created (${org.name}) and trainer assigned`);
    res.json({ organizationId: org.id, organizationName: org.name, role: 'trainer' });
  } catch (err) {
    console.error('[org] Bootstrap failed:', err.message || err);
    res.status(500).json({ error: 'Failed to bootstrap organization' });
  }
});

app.post('/api/admin/trainers', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const targetEmail = normalizeEmail(req.body?.email);
  const orgName = coerceText(req.body?.orgName);
  const organizationId = coerceText(req.body?.organizationId);
  const tempPassword = coerceText(req.body?.password);
  if (!targetEmail) {
    res.status(400).json({ error: 'Missing trainer email' });
    return;
  }

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;

    const allUsers = await listUsers(200);
    let targetUser = allUsers.find((candidate) => normalizeEmail(candidate.email) === targetEmail);

    if (!targetUser) {
      if (!supabase?.auth?.admin) {
        res.status(500).json({ error: 'Supabase admin API unavailable' });
        return;
      }

      if (tempPassword) {
        const { data: created, error: createError } = await supabase.auth.admin.createUser({
          email: targetEmail,
          password: tempPassword,
          email_confirm: true,
        });
        if (createError || !created?.user) {
          console.error('[admin] Failed to create user:', createError?.message || createError);
          res.status(500).json({ error: 'Failed to create trainer user' });
          return;
        }
        targetUser = created.user;
      } else {
        const { data: invited, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(targetEmail);
        if (inviteError || !invited?.user) {
          console.error('[admin] Failed to invite user:', inviteError?.message || inviteError);
          res.status(500).json({ error: 'Failed to invite trainer user' });
          return;
        }
        targetUser = invited.user;
      }
    }

    const { data: existingMember } = await supabase
      .from('organization_members')
      .select('id')
      .eq('user_id', targetUser.id)
      .maybeSingle();

    if (existingMember) {
      res.status(409).json({ error: 'User already assigned to an organization' });
      return;
    }

    let org = null;
    if (organizationId) {
      const { data: existingOrg, error: orgFetchError } = await supabase
        .from('organizations')
        .select('id, name')
        .eq('id', organizationId)
        .maybeSingle();

      if (orgFetchError || !existingOrg) {
        console.error('[admin] Failed to load organization:', orgFetchError?.message || orgFetchError);
        res.status(404).json({ error: 'Organization not found' });
        return;
      }
      org = existingOrg;
    } else {
      const fallbackName = targetUser.email ? targetUser.email.split('@')[0] : 'Trainer';
      const trainerOrgName = orgName || `Team ${fallbackName}`;

      const { data: createdOrg, error: orgError } = await supabase
        .from('organizations')
        .insert({ name: trainerOrgName })
        .select('id, name')
        .single();

      if (orgError || !createdOrg) {
        console.error('[admin] Failed to create organization:', orgError?.message || orgError);
        res.status(500).json({ error: 'Failed to create organization' });
        return;
      }
      org = createdOrg;
    }

    const { error: memberError } = await supabase
      .from('organization_members')
      .insert({ organization_id: org.id, user_id: targetUser.id, role: 'trainer' });

    if (memberError) {
      console.error('[admin] Failed to add trainer:', memberError.message || memberError);
      res.status(500).json({ error: 'Failed to add trainer' });
      return;
    }

    console.log(`[admin] Trainer created: ${targetUser.email}`);
    res.json({ success: true, user_id: targetUser.id, email: targetUser.email, organizationId: org.id });
  } catch (err) {
    console.error('[admin] Failed to create trainer:', err.message || err);
    res.status(500).json({ error: 'Failed to create trainer' });
  }
});

app.get('/api/org/me', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const membership = await getMembership(user.id);
    if (!membership) {
      res.json({ role: null, organizationId: null, organizationName: null });
      return;
    }
    console.log(`[org] Role detected: ${membership.role}`);
    res.json({
      role: membership.role,
      organizationId: membership.organization_id,
      organizationName: membership.organizations?.name || 'Organization',
    });
  } catch (err) {
    console.error('[org] Failed to load membership:', err.message || err);
    res.status(500).json({ error: 'Failed to load organization membership' });
  }
});

app.get('/api/org/unassigned', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const membership = await requireTrainer(user.id, res);
    if (!membership) return;

    const allUsers = await listUsers(200);
    const { data: members, error } = await supabase
      .from('organization_members')
      .select('user_id');

    if (error) {
      console.error('[org] Failed to fetch members:', error.message || error);
      res.status(500).json({ error: 'Failed to fetch members' });
      return;
    }

    const admins = await getAdmins();
    const adminIds = new Set((admins || []).map((admin) => admin.user_id));
    const assigned = new Set((members || []).map((member) => member.user_id));
    const unassigned = allUsers
      .filter((candidate) => candidate?.id && candidate?.email)
      .filter((candidate) => !assigned.has(candidate.id))
      .filter((candidate) => !adminIds.has(candidate.id))
      .map((candidate) => ({ user_id: candidate.id, email: candidate.email }));

    res.json({ users: unassigned });
  } catch (err) {
    console.error('[org] Failed to load unassigned users:', err.message || err);
    res.status(500).json({ error: 'Failed to load unassigned users' });
  }
});

app.post('/api/org/assign', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const traineeEmail = normalizeEmail(req.body?.email);
  if (!traineeEmail) {
    res.status(400).json({ error: 'Missing trainee email' });
    return;
  }

  try {
    const membership = await requireTrainer(user.id, res);
    if (!membership) return;

    const allUsers = await listUsers(200);
    const targetUser = allUsers.find((candidate) => normalizeEmail(candidate.email) === traineeEmail);
    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { data: existingMember } = await supabase
      .from('organization_members')
      .select('id')
      .eq('user_id', targetUser.id)
      .maybeSingle();

    if (existingMember) {
      res.status(409).json({ error: 'User already assigned to an organization' });
      return;
    }

    const { error: insertError } = await supabase
      .from('organization_members')
      .insert({
        organization_id: membership.organization_id,
        user_id: targetUser.id,
        role: 'trainee',
      });

    if (insertError) {
      console.error('[org] Failed to add trainee:', insertError.message || insertError);
      res.status(500).json({ error: 'Failed to assign trainee' });
      return;
    }

    console.log(`[org] Member added: ${targetUser.email}`);
    res.json({ success: true, user_id: targetUser.id, email: targetUser.email });
  } catch (err) {
    console.error('[org] Failed to assign trainee:', err.message || err);
    res.status(500).json({ error: 'Failed to assign trainee' });
  }
});

app.get('/api/org/team', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const membership = await requireTrainer(user.id, res);
    if (!membership) return;

    const members = await getOrgMembers(membership.organization_id);
    const trainees = members.filter((member) => member.role === 'trainee');
    const traineeIds = trainees.map((member) => member.user_id);

    if (traineeIds.length === 0) {
      res.json({ members: [] });
      return;
    }

    const allUsers = await listUsers(200);
    const emailMap = new Map(allUsers.map((candidate) => [candidate.id, candidate.email]));

    const { data: sessions, error: sessionError } = await supabase
      .from('call_sessions')
      .select('user_id, feedback')
      .in('user_id', traineeIds);

    if (sessionError) {
      console.error('[org] Failed to fetch team sessions:', sessionError.message || sessionError);
      res.status(500).json({ error: 'Failed to fetch team sessions' });
      return;
    }

    const stats = new Map();
    (sessions || []).forEach((session) => {
      const feedback = session.feedback || {};
      const overall = toNumber(feedback.overall_score) ?? 0;
      const objection = toNumber(feedback.objection_handling) ?? 0;
      const clarity = toNumber(feedback.communication_clarity) ?? 0;
      const confidence = toNumber(feedback.confidence) ?? 0;
      if (!stats.has(session.user_id)) {
        stats.set(session.user_id, {
          count: 0,
          overall: 0,
          objection: 0,
          clarity: 0,
          confidence: 0,
        });
      }
      const entry = stats.get(session.user_id);
      entry.count += 1;
      entry.overall += overall;
      entry.objection += objection;
      entry.clarity += clarity;
      entry.confidence += confidence;
    });

    const membersPayload = traineeIds.map((traineeId) => {
      const entry = stats.get(traineeId) || {
        count: 0,
        overall: 0,
        objection: 0,
        clarity: 0,
        confidence: 0,
      };
      const count = entry.count || 0;
      return {
        user_id: traineeId,
        email: emailMap.get(traineeId) || 'Unknown',
        avgOverallScore: count > 0 ? entry.overall / count : 0,
        avgObjectionHandling: count > 0 ? entry.objection / count : 0,
        avgCommunicationClarity: count > 0 ? entry.clarity / count : 0,
        avgConfidence: count > 0 ? entry.confidence / count : 0,
        sessionCount: count,
      };
    });

    res.json({ members: membersPayload });
  } catch (err) {
    console.error('[org] Failed to fetch team data:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch team data' });
  }
});

app.get('/api/admin/me', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;
    res.json({ isAdmin: true, userId: user.id });
  } catch (err) {
    console.error('[admin] Failed to check admin:', err.message || err);
    res.status(500).json({ error: 'Failed to verify admin' });
  }
});

app.get('/api/admin/trainers', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;

    const { data: trainers, error } = await supabase
      .from('organization_members')
      .select('user_id, organization_id, role, organizations(name)')
      .eq('role', 'trainer');

    if (error) {
      console.error('[admin] Failed to fetch trainers:', error.message || error);
      res.status(500).json({ error: 'Failed to fetch trainers' });
      return;
    }

    const allUsers = await listUsers(200);
    const emailMap = new Map(allUsers.map((candidate) => [candidate.id, candidate.email]));

    const payload = (trainers || []).map((trainer) => ({
      user_id: trainer.user_id,
      email: emailMap.get(trainer.user_id) || 'Unknown',
      organization_id: trainer.organization_id,
      organization_name: trainer.organizations?.name || 'Organization',
      role: trainer.role,
    }));

    res.json({ trainers: payload });
  } catch (err) {
    console.error('[admin] Failed to load trainers:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch trainers' });
  }
});

app.patch('/api/admin/trainers/:userId', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const targetUserId = req.params.userId;
  const organizationId = coerceText(req.body?.organizationId);

  if (!targetUserId || !organizationId) {
    res.status(400).json({ error: 'Missing trainer or organization' });
    return;
  }

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;

    const { data, error } = await supabase
      .from('organization_members')
      .update({ organization_id: organizationId, role: 'trainer' })
      .eq('user_id', targetUserId)
      .select('user_id, organization_id')
      .maybeSingle();

    if (error || !data) {
      console.error('[admin] Failed to update trainer:', error?.message || error);
      res.status(500).json({ error: 'Failed to update trainer' });
      return;
    }

    res.json({ success: true, trainer: data });
  } catch (err) {
    console.error('[admin] Failed to update trainer:', err.message || err);
    res.status(500).json({ error: 'Failed to update trainer' });
  }
});

app.delete('/api/admin/trainers/:userId', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const targetUserId = req.params.userId;
  if (!targetUserId) {
    res.status(400).json({ error: 'Missing trainer id' });
    return;
  }

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;

    const { error } = await supabase
      .from('organization_members')
      .delete()
      .eq('user_id', targetUserId)
      .eq('role', 'trainer');

    if (error) {
      console.error('[admin] Failed to remove trainer:', error.message || error);
      res.status(500).json({ error: 'Failed to remove trainer' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[admin] Failed to remove trainer:', err.message || err);
    res.status(500).json({ error: 'Failed to remove trainer' });
  }
});

app.get('/api/admin/orgs', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;

    const { data, error } = await supabase
      .from('organizations')
      .select('id, name, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[admin] Failed to load organizations:', error.message || error);
      res.status(500).json({ error: 'Failed to load organizations' });
      return;
    }

    res.json({ organizations: data || [] });
  } catch (err) {
    console.error('[admin] Failed to load organizations:', err.message || err);
    res.status(500).json({ error: 'Failed to load organizations' });
  }
});

app.post('/api/admin/orgs', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const orgName = coerceText(req.body?.name);
  if (!orgName) {
    res.status(400).json({ error: 'Missing organization name' });
    return;
  }

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;

    const { data, error } = await supabase
      .from('organizations')
      .insert({ name: orgName })
      .select('id, name')
      .single();

    if (error || !data) {
      console.error('[admin] Failed to create organization:', error?.message || error);
      res.status(500).json({ error: 'Failed to create organization' });
      return;
    }

    res.json({ organization: data });
  } catch (err) {
    console.error('[admin] Failed to create organization:', err.message || err);
    res.status(500).json({ error: 'Failed to create organization' });
  }
});

app.patch('/api/admin/orgs/:orgId', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const orgId = req.params.orgId;
  const orgName = coerceText(req.body?.name);
  if (!orgId || !orgName) {
    res.status(400).json({ error: 'Missing organization details' });
    return;
  }

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;

    const { data, error } = await supabase
      .from('organizations')
      .update({ name: orgName })
      .eq('id', orgId)
      .select('id, name')
      .single();

    if (error || !data) {
      console.error('[admin] Failed to update organization:', error?.message || error);
      res.status(500).json({ error: 'Failed to update organization' });
      return;
    }

    res.json({ organization: data });
  } catch (err) {
    console.error('[admin] Failed to update organization:', err.message || err);
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

app.delete('/api/admin/orgs/:orgId', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const orgId = req.params.orgId;
  if (!orgId) {
    res.status(400).json({ error: 'Missing organization id' });
    return;
  }

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;

    const { error: memberError } = await supabase
      .from('organization_members')
      .delete()
      .eq('organization_id', orgId);

    if (memberError) {
      console.error('[admin] Failed to remove org members:', memberError.message || memberError);
      res.status(500).json({ error: 'Failed to remove org members' });
      return;
    }

    const { error: orgError } = await supabase
      .from('organizations')
      .delete()
      .eq('id', orgId);

    if (orgError) {
      console.error('[admin] Failed to delete organization:', orgError.message || orgError);
      res.status(500).json({ error: 'Failed to delete organization' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[admin] Failed to delete organization:', err.message || err);
    res.status(500).json({ error: 'Failed to delete organization' });
  }
});

app.patch('/api/admin/users/:userId', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const targetUserId = req.params.userId;
  const nextEmail = normalizeEmail(req.body?.email);
  const nextPassword = coerceText(req.body?.password);

  if (!targetUserId || (!nextEmail && !nextPassword)) {
    res.status(400).json({ error: 'Missing user update details' });
    return;
  }

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;

    const payload = {};
    if (nextEmail) payload.email = nextEmail;
    if (nextPassword) payload.password = nextPassword;

    const { data, error } = await supabase.auth.admin.updateUserById(targetUserId, payload);
    if (error) {
      console.error('[admin] Failed to update user:', error.message || error);
      res.status(500).json({ error: 'Failed to update user' });
      return;
    }

    res.json({ success: true, user: data?.user || null });
  } catch (err) {
    console.error('[admin] Failed to update user:', err.message || err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.post('/api/admin/users/:userId/disable', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const targetUserId = req.params.userId;
  if (!targetUserId) {
    res.status(400).json({ error: 'Missing user id' });
    return;
  }

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;

    const { error } = await supabase.auth.admin.updateUserById(targetUserId, {
      ban_duration: '87600h',
    });

    if (error) {
      console.error('[admin] Failed to disable user:', error.message || error);
      res.status(500).json({ error: 'Failed to disable user' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[admin] Failed to disable user:', err.message || err);
    res.status(500).json({ error: 'Failed to disable user' });
  }
});

app.post('/api/admin/users/:userId/enable', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const targetUserId = req.params.userId;
  if (!targetUserId) {
    res.status(400).json({ error: 'Missing user id' });
    return;
  }

  try {
    const admin = await requireAdmin(user.id, res);
    if (!admin) return;

    const { error } = await supabase.auth.admin.updateUserById(targetUserId, {
      ban_duration: 'none',
    });

    if (error) {
      console.error('[admin] Failed to enable user:', error.message || error);
      res.status(500).json({ error: 'Failed to enable user' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[admin] Failed to enable user:', err.message || err);
    res.status(500).json({ error: 'Failed to enable user' });
  }
});

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

app.get('/api/report/analytics', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    let scopedUserIds = [user.id];
    const membership = await getMembership(user.id);
    if (membership?.role === 'trainer') {
      const members = await getOrgMembers(membership.organization_id);
      scopedUserIds = members.map((member) => member.user_id);
      console.log('[org] Role detected: trainer');
    } else if (membership?.role === 'trainee') {
      console.log('[org] Role detected: trainee');
    }

    const analytics = await fetchAnalyticsData(scopedUserIds);
    const { data: feedbackRows, error: feedbackError } = await supabase
      .from('call_sessions')
      .select('feedback, scenario, created_at, overall_score:feedback->>overall_score')
      .in('user_id', scopedUserIds)
      .order('created_at', { ascending: true })
      .limit(500);

    if (feedbackError) {
      throw feedbackError;
    }

    const rows = Array.isArray(feedbackRows) ? feedbackRows : [];
    const commonStrengths = tallyListItems(rows, 'strengths').slice(0, 5);
    const commonWeaknesses = tallyListItems(rows, 'weaknesses').slice(0, 5);
    const commonSuggestions = tallyListItems(rows, 'actionable_suggestions').slice(0, 5);
    const commonWeaknessCounts = tallyListCounts(rows, 'weaknesses').slice(0, 5);
    const trendDelta = computeTrendDelta(rows);

    const trendPoints = analytics.trend
      .filter((point) => typeof point.overall_score === 'number')
      .slice(-12)
      .map((point) => ({ value: Number(point.overall_score) }));

    const scenarioBars = analytics.byScenario.map((entry) => ({
      label: entry.scenario,
      value: roundScore(entry.avgOverallScore) || 0,
    }));

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="performance-analytics-${user.id}.pdf"`
    );

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111111');
    doc.text('Sales Training Performance Report', { align: 'left' });

    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).fillColor('#333333');
    doc.text('Report Type: Overall Performance Summary');
    doc.text(`Date: ${formatDate(new Date())}`);
    if (analytics.range?.start && analytics.range?.end) {
      doc.text(`Date Range: ${formatDate(analytics.range.start)} - ${formatDate(analytics.range.end)}`);
    }
    addDivider(doc);

    addSectionTitle(doc, 'Summary');
    doc.text(`Total Sessions: ${analytics.summary.totalSessions}`);
    doc.text(`Average Overall Score: ${formatScore(analytics.summary.avgOverallScore)}`);
    doc.text(`Average Objection Handling: ${formatScore(analytics.summary.avgObjectionHandling)}`);
    doc.text(`Average Communication Clarity: ${formatScore(analytics.summary.avgCommunicationClarity)}`);
    doc.text(`Average Confidence: ${formatScore(analytics.summary.avgConfidence)}`);
    doc.text(`Best Score: ${formatScore(analytics.summary.bestScore)}`);
    doc.text(`Worst Score: ${formatScore(analytics.summary.worstScore)}`);

    addSectionTitle(doc, 'Performance Trend');
    if (trendDelta === null) {
      doc.text('Not enough data to calculate recent trend.');
    } else if (trendDelta > 0) {
      doc.text(`Recent sessions improved by ${trendDelta} points on average.`);
    } else if (trendDelta < 0) {
      doc.text(`Recent sessions declined by ${Math.abs(trendDelta)} points on average.`);
    } else {
      doc.text('Recent sessions are stable.');
    }
    if (trendPoints.length >= 2) {
      drawLineChart(doc, trendPoints, { width: 420, height: 140 });
    }

    addSectionTitle(doc, 'Scenario Breakdown');
    if (analytics.byScenario.length === 0) {
      doc.text('No scenario data available.');
    } else {
      const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      analytics.byScenario.forEach((entry, index) => {
        doc.text(
          `${index + 1}. ${entry.scenario} — Avg Overall: ${formatScore(entry.avgOverallScore)} (Sessions: ${entry.count})`,
          { width }
        );
      });
    }
    if (scenarioBars.length > 0) {
      drawBarChart(doc, scenarioBars, { width: 420, height: 140, barColor: '#10b981', maxItems: 6 });
    }

    addSectionTitle(doc, 'Common Strengths');
    if (commonStrengths.length === 0) {
      doc.text('No strengths recorded.');
    } else {
      addBulletList(doc, commonStrengths);
    }

    addSectionTitle(doc, 'Common Improvement Areas');
    if (commonWeaknesses.length === 0) {
      doc.text('No improvement areas recorded.');
    } else {
      addBulletList(doc, commonWeaknesses);
    }
    if (commonWeaknessCounts.length > 0) {
      drawBarChart(doc, commonWeaknessCounts, { width: 420, height: 140, barColor: '#ef4444', maxItems: 5 });
    }

    addSectionTitle(doc, 'Suggested Action Plan');
    if (commonSuggestions.length === 0) {
      doc.text('No suggestions recorded.');
    } else {
      addBulletList(doc, commonSuggestions);
    }

    doc.end();
  } catch (err) {
    console.error('[report] Failed to generate analytics report:', err.message || err);
    res.status(500).json({ error: 'Failed to generate analytics report' });
  }
});

app.get('/api/report/:sessionId', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const sessionId = req.params.sessionId;
  if (!sessionId) {
    res.status(400).json({ error: 'Missing session id' });
    return;
  }

  try {
    const { data, error } = await supabase
      .from('call_sessions')
      .select('id, user_id, scenario, call_duration, transcript, feedback, created_at')
      .eq('id', sessionId)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[supabase] Failed to fetch report session:', error.message || error);
      res.status(500).json({ error: 'Failed to fetch session' });
      return;
    }

    if (!data) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (data.user_id !== user.id) {
      const membership = await getMembership(user.id);
      if (!membership || membership.role !== 'trainer') {
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }
      const { data: sameOrg } = await supabase
        .from('organization_members')
        .select('id')
        .eq('organization_id', membership.organization_id)
        .eq('user_id', data.user_id)
        .maybeSingle();

      if (!sameOrg) {
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }
      console.log('[org] Role detected: trainer');
    }

    const feedback = data.feedback || {};
    const difficulty = feedback.difficulty || 'Unknown';
    const summary = summarizeTranscript(data.transcript);
    const strengths = coerceList(feedback.strengths);
    const weaknesses = coerceList(feedback.weaknesses);
    const suggestions = coerceList(feedback.actionable_suggestions);
    const insights = buildSessionInsights(feedback);
    const skillChart = [
      { label: 'Overall', value: roundScore(feedback.overall_score) || 0 },
      { label: 'Objection', value: roundScore(feedback.objection_handling) || 0 },
      { label: 'Clarity', value: roundScore(feedback.communication_clarity) || 0 },
      { label: 'Confidence', value: roundScore(feedback.confidence) || 0 },
    ];

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="performance-report-${data.id}.pdf"`
    );

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111111');
    doc.text('Sales Training Performance Report', { align: 'left' });

    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).fillColor('#333333');
    doc.text(`Date: ${formatDate(data.created_at)}`);
    doc.text(`Scenario: ${data.scenario || 'Unknown'}`);
    doc.text(`Difficulty Level: ${difficulty}`);
    doc.text(`Call Duration: ${formatDuration(data.call_duration)}`);
    addDivider(doc);

    addSectionTitle(doc, 'Overall Score');
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#111111');
    doc.text(formatScore(feedback.overall_score));
    doc.font('Helvetica').fontSize(11).fillColor('#333333');

    addSectionTitle(doc, 'Key Insights');
    addBulletList(doc, insights);

    addSectionTitle(doc, 'Skill Breakdown');
    doc.text(`Objection Handling: ${formatScore(feedback.objection_handling)}`);
    doc.text(`Communication Clarity: ${formatScore(feedback.communication_clarity)}`);
    doc.text(`Confidence: ${formatScore(feedback.confidence)}`);

    addSectionTitle(doc, 'Skill Snapshot');
    drawBarChart(doc, skillChart, { width: 420, height: 120, barColor: '#2563eb' });

    addSectionTitle(doc, 'Transcript Summary');
    doc.text(summary);

    addSectionTitle(doc, 'Strengths');
    if (strengths.length === 0) {
      doc.text('No strengths recorded.');
    } else {
      addBulletList(doc, strengths);
    }

    addSectionTitle(doc, 'Areas for Improvement');
    if (weaknesses.length === 0) {
      doc.text('No improvement areas recorded.');
    } else {
      addBulletList(doc, weaknesses);
    }

    addSectionTitle(doc, 'Actionable Suggestions');
    if (suggestions.length === 0) {
      doc.text('No suggestions recorded.');
    } else {
      addBulletList(doc, suggestions);
    }

    addSectionTitle(doc, 'Next Session Focus');
    if (weaknesses.length > 0) {
      addBulletList(doc, weaknesses.slice(0, 3).map((item) => `Focus on: ${item}`));
    } else if (suggestions.length > 0) {
      addBulletList(doc, suggestions.slice(0, 3).map((item) => `Practice: ${item}`));
    } else {
      doc.text('Maintain consistency and build on current strengths.');
    }

    addSectionTitle(doc, 'Practice Checklist');
    const checklist = [];
    if (suggestions.length > 0) {
      checklist.push(...suggestions.slice(0, 5));
    }
    if (checklist.length === 0 && weaknesses.length > 0) {
      checklist.push(...weaknesses.slice(0, 5));
    }
    if (checklist.length === 0) {
      doc.text('Keep reinforcing strong habits and try a more challenging scenario.');
    } else {
      addBulletList(doc, checklist.map((item) => `Practice: ${item}`));
    }

    doc.end();
  } catch (err) {
    console.error('[report] Failed to generate PDF report:', err.message || err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// TODO: Add multi-user filtering for analytics.
// TODO: Add trainer dashboard aggregation layer.
// TODO: Add export reports (PDF/CSV).
app.get('/api/analytics', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    let scopedUserIds = [user.id];
    const membership = await getMembership(user.id);
    if (membership?.role === 'trainer') {
      const members = await getOrgMembers(membership.organization_id);
      scopedUserIds = members.map((member) => member.user_id);
      console.log('[org] Role detected: trainer');
    } else if (membership?.role === 'trainee') {
      console.log('[org] Role detected: trainee');
    }

    const analytics = await fetchAnalyticsData(scopedUserIds);
    res.json({
      summary: analytics.summary,
      trend: analytics.trend,
      byScenario: analytics.byScenario,
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
