"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "../../../../lib/supabaseClient";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001";

type AnalyticsSummary = {
  totalSessions: number;
  avgOverallScore: number;
  avgObjectionHandling: number;
  avgCommunicationClarity: number;
  avgConfidence: number;
  bestScore: number;
  worstScore: number;
};

type AnalyticsTrendPoint = {
  created_at: string;
  overall_score: number | null;
};

type AnalyticsScenario = {
  scenario: string;
  avgOverallScore: number;
  count: number;
};

type ConversationMetrics = {
  avg_talk_ratio: number;
  avg_user_questions: number;
  avg_customer_questions: number;
  avg_filler_word_count: number;
  avg_filler_word_rate: number;
  avg_turn_length: number;
  avg_longest_monologue: number;
  avg_interruption_count: number;
  avg_engagement_score: number;
  avg_response_latency_ms: number | null;
  avg_words_per_minute: number;
  avg_rapport_phrases: number;
  objection_session_pct: number;
  pricing_session_pct: number;
  competitor_session_pct: number;
  closing_session_pct: number;
  customer_objection_pct: number;
  total_sessions: number;
};

type VoiceMetrics = {
  avg_speaking_rate_wpm: number;
  avg_silence_duration_ms: number;
  avg_pause_ms: number;
  avg_hesitation_count: number;
  avg_hesitation_rate: number;
  avg_stt_confidence: number | null;
  avg_confidence_score: number;
  avg_vocal_clarity_score: number;
  avg_energy_score: number;
  total_sessions: number;
};

type TraineeAnalytics = {
  traineeId: string;
  traineeEmail: string;
  summary: AnalyticsSummary;
  trend: AnalyticsTrendPoint[];
  byScenario: AnalyticsScenario[];
  conversationMetrics?: ConversationMetrics | null;
  voiceMetrics?: VoiceMetrics | null;
};

type SessionRow = {
  id: string;
  scenario: string;
  call_duration: number;
  overall_score: number | string | null;
  created_at: string;
};

export default function TraineeAnalyticsPage() {
  const router = useRouter();
  const params = useParams<{ userId: string }>();
  const traineeId = params?.userId || "";

  const [authToken, setAuthToken] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [analytics, setAnalytics] = useState<TraineeAnalytics | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionLoading, setSessionLoading] = useState<boolean>(true);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const session = data.session;
      if (!session) {
        router.push("/login");
        return;
      }
      setAuthToken(session.access_token);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setAuthToken("");
        router.push("/login");
        return;
      }
      setAuthToken(session.access_token);
    });

    return () => {
      active = false;
      authListener?.subscription.unsubscribe();
    };
  }, [router]);

  useEffect(() => {
    if (!authToken || !traineeId) return;
    let active = true;

    async function loadAnalytics() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`${API_BASE}/api/org/trainees/${traineeId}/analytics`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!response.ok) {
          throw new Error(`Analytics request failed (${response.status})`);
        }
        const payload = (await response.json()) as TraineeAnalytics;
        if (active) {
          setAnalytics(payload);
        }
      } catch (err) {
        console.error("Failed to load trainee analytics", err);
        if (active) setError("Failed to load trainee analytics");
      } finally {
        if (active) setLoading(false);
      }
    }

    async function loadSessions() {
      setSessionLoading(true);
      try {
        const response = await fetch(`${API_BASE}/api/org/trainees/${traineeId}/sessions`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!response.ok) {
          throw new Error(`Sessions request failed (${response.status})`);
        }
        const payload = await response.json();
        if (active) {
          setSessions(Array.isArray(payload?.sessions) ? payload.sessions : []);
        }
      } catch (err) {
        console.error("Failed to load trainee sessions", err);
        if (active) setSessions([]);
      } finally {
        if (active) setSessionLoading(false);
      }
    }

    loadAnalytics();
    loadSessions();

    return () => {
      active = false;
    };
  }, [authToken, traineeId]);

  async function downloadSessionReport(sessionId: string) {
    if (!authToken) return;

    try {
      const response = await fetch(`${API_BASE}/api/report/${sessionId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!response.ok) {
        throw new Error(`Report request failed (${response.status})`);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `session-report-${sessionId}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to download report", err);
    }
  }

  const trendData = useMemo(() => {
    if (!analytics?.trend) return [];
    return analytics.trend
      .filter((point) => typeof point.overall_score === "number")
      .map((point) => ({
        date: new Date(point.created_at).toLocaleDateString(),
        overall_score: Number(point.overall_score),
      }));
  }, [analytics]);

  const scenarioData = useMemo(() => {
    if (!analytics?.byScenario) return [];
    return analytics.byScenario.map((entry) => ({
      scenario: entry.scenario,
      avgOverallScore: Number(entry.avgOverallScore.toFixed(2)),
      count: entry.count,
    }));
  }, [analytics]);

  const summary = analytics?.summary;
  const hasData = summary && summary.totalSessions > 0;

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "3rem 2rem",
        background: "linear-gradient(135deg, #0b1220, #12203a)",
        color: "#e2e8f0",
        fontFamily: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ maxWidth: "1200px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "2rem" }}>
        <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <p style={{ margin: 0, textTransform: "uppercase", letterSpacing: "0.2em", fontSize: "0.75rem" }}>
            Trainee Detail
          </p>
          <h1 style={{ margin: 0, fontSize: "2.3rem", fontWeight: 700 }}>
            {analytics?.traineeEmail || "Trainee"}
          </h1>
          <div style={{ marginTop: "0.5rem" }}>
            <Link
              href="/analytics"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
                padding: "0.45rem 0.85rem",
                borderRadius: "999px",
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(148, 163, 184, 0.15)",
                color: "#e2e8f0",
                textDecoration: "none",
                fontSize: "0.85rem",
                fontWeight: 600,
              }}
            >
              Back to Team
            </Link>
          </div>
        </header>

        {loading && (
          <div style={{ padding: "1.5rem", borderRadius: "16px", background: "rgba(15, 23, 42, 0.7)" }}>
            Loading trainee analytics...
          </div>
        )}

        {!loading && error && (
          <div
            style={{
              padding: "1.5rem",
              borderRadius: "16px",
              background: "rgba(239, 68, 68, 0.15)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && !hasData && (
          <div style={{ padding: "1.5rem", borderRadius: "16px", background: "rgba(15, 23, 42, 0.7)" }}>
            No sessions yet for this trainee.
          </div>
        )}

        {!loading && !error && hasData && summary && (
          <>
            <section
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "1rem",
              }}
            >
              {[
                { label: "Total Calls", value: summary.totalSessions },
                { label: "Avg Overall Score", value: summary.avgOverallScore.toFixed(2) },
                { label: "Best Score", value: summary.bestScore.toFixed(2) },
                { label: "Worst Score", value: summary.worstScore.toFixed(2) },
              ].map((item) => (
                <div
                  key={item.label}
                  style={{
                    padding: "1.25rem",
                    borderRadius: "16px",
                    background: "rgba(15, 23, 42, 0.85)",
                    border: "1px solid rgba(148, 163, 184, 0.15)",
                  }}
                >
                  <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.7 }}>{item.label}</p>
                  <p style={{ margin: "0.5rem 0 0", fontSize: "1.8rem", fontWeight: 600 }}>{item.value}</p>
                </div>
              ))}
            </section>

            <section
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                gap: "1.5rem",
              }}
            >
              <div
                style={{
                  padding: "1.5rem",
                  borderRadius: "18px",
                  background: "rgba(15, 23, 42, 0.85)",
                  border: "1px solid rgba(148, 163, 184, 0.15)",
                }}
              >
                <h2 style={{ margin: "0 0 1rem", fontSize: "1.2rem" }}>Overall Score Trend</h2>
                <div style={{ width: "100%", height: "260px" }}>
                  <ResponsiveContainer>
                    <LineChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2a44" />
                      <XAxis dataKey="date" stroke="#94a3b8" tick={{ fontSize: 12 }} />
                      <YAxis domain={[0, 10]} stroke="#94a3b8" tick={{ fontSize: 12 }} />
                      <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1f2a44" }} />
                      <Line type="monotone" dataKey="overall_score" stroke="#38bdf8" strokeWidth={3} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div
                style={{
                  padding: "1.5rem",
                  borderRadius: "18px",
                  background: "rgba(15, 23, 42, 0.85)",
                  border: "1px solid rgba(148, 163, 184, 0.15)",
                }}
              >
                <h2 style={{ margin: "0 0 1rem", fontSize: "1.2rem" }}>Average Score by Scenario</h2>
                <div style={{ width: "100%", height: "260px" }}>
                  <ResponsiveContainer>
                    <BarChart data={scenarioData} layout="vertical" margin={{ left: 24 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2a44" />
                      <XAxis type="number" domain={[0, 10]} stroke="#94a3b8" tick={{ fontSize: 12 }} />
                      <YAxis type="category" dataKey="scenario" stroke="#94a3b8" tick={{ fontSize: 12 }} width={140} />
                      <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1f2a44" }} />
                      <Bar dataKey="avgOverallScore" fill="#22d3ee" radius={[6, 6, 6, 6]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </section>

            {/* Conversation Intelligence Metrics */}
            {analytics?.conversationMetrics && (
              <>
                <section>
                  <h2 style={{ margin: "0 0 1rem", fontSize: "1.3rem", fontWeight: 700 }}>Conversation Intelligence</h2>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                      gap: "1rem",
                    }}
                  >
                    {[
                      { label: "Talk Ratio", value: `${(analytics.conversationMetrics.avg_talk_ratio * 100).toFixed(0)}%`, sub: "Trainee speaking share" },
                      { label: "Engagement", value: `${analytics.conversationMetrics.avg_engagement_score}/10`, sub: "Composite score" },
                      { label: "Questions Asked", value: `${analytics.conversationMetrics.avg_user_questions}`, sub: "Avg per session" },
                      { label: "Filler Rate", value: `${analytics.conversationMetrics.avg_filler_word_rate}%`, sub: "Of total words" },
                      { label: "Interruptions", value: `${analytics.conversationMetrics.avg_interruption_count}`, sub: "Avg per session" },
                      { label: "Avg Turn Length", value: `${analytics.conversationMetrics.avg_turn_length} words`, sub: "Per trainee turn" },
                      { label: "Speaking Pace", value: `${analytics.conversationMetrics.avg_words_per_minute} wpm`, sub: "Words per minute" },
                      { label: "Response Latency", value: analytics.conversationMetrics.avg_response_latency_ms != null ? `${(analytics.conversationMetrics.avg_response_latency_ms / 1000).toFixed(1)}s` : "N/A", sub: "Avg delay" },
                    ].map((item) => (
                      <div
                        key={item.label}
                        style={{
                          padding: "1.1rem",
                          borderRadius: "14px",
                          background: "rgba(15, 23, 42, 0.85)",
                          border: "1px solid rgba(148, 163, 184, 0.15)",
                        }}
                      >
                        <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.1em" }}>{item.label}</p>
                        <p style={{ margin: "0.4rem 0 0", fontSize: "1.5rem", fontWeight: 700 }}>{item.value}</p>
                        <p style={{ margin: "0.2rem 0 0", fontSize: "0.7rem", opacity: 0.5 }}>{item.sub}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <section
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                    gap: "1.5rem",
                  }}
                >
                  <div
                    style={{
                      padding: "1.5rem",
                      borderRadius: "18px",
                      background: "rgba(15, 23, 42, 0.85)",
                      border: "1px solid rgba(148, 163, 184, 0.15)",
                    }}
                  >
                    <h2 style={{ margin: "0 0 1rem", fontSize: "1.2rem" }}>Topic Detection (% of sessions)</h2>
                    <div style={{ width: "100%", height: "220px" }}>
                      <ResponsiveContainer>
                        <BarChart
                          data={[
                            { topic: "Objections", pct: analytics.conversationMetrics.customer_objection_pct },
                            { topic: "Pricing", pct: analytics.conversationMetrics.pricing_session_pct },
                            { topic: "Competitors", pct: analytics.conversationMetrics.competitor_session_pct },
                            { topic: "Closing", pct: analytics.conversationMetrics.closing_session_pct },
                          ]}
                          layout="vertical"
                          margin={{ left: 24 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#1f2a44" />
                          <XAxis type="number" domain={[0, 100]} stroke="#94a3b8" tick={{ fontSize: 12 }} unit="%" />
                          <YAxis type="category" dataKey="topic" stroke="#94a3b8" tick={{ fontSize: 12 }} width={100} />
                          <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1f2a44" }} formatter={(v: number) => `${v}%`} />
                          <Bar dataKey="pct" fill="#a78bfa" radius={[6, 6, 6, 6]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div
                    style={{
                      padding: "1.5rem",
                      borderRadius: "18px",
                      background: "rgba(15, 23, 42, 0.85)",
                      border: "1px solid rgba(148, 163, 184, 0.15)",
                    }}
                  >
                    <h2 style={{ margin: "0 0 1rem", fontSize: "1.2rem" }}>Conversation Quality Profile</h2>
                    <div style={{ width: "100%", height: "280px" }}>
                      <ResponsiveContainer>
                        <RadarChart
                          data={[
                            { metric: "Engagement", value: analytics.conversationMetrics.avg_engagement_score },
                            { metric: "Talk Balance", value: Math.min(10, (1 - Math.abs(analytics.conversationMetrics.avg_talk_ratio - 0.5) * 4) * 10) },
                            { metric: "Questions", value: Math.min(10, analytics.conversationMetrics.avg_user_questions * 2) },
                            { metric: "Rapport", value: Math.min(10, analytics.conversationMetrics.avg_rapport_phrases * 2) },
                            { metric: "Fluency", value: Math.max(0, 10 - analytics.conversationMetrics.avg_filler_word_rate) },
                          ]}
                          outerRadius={90}
                        >
                          <PolarGrid stroke="#1f2a44" />
                          <PolarAngleAxis dataKey="metric" stroke="#94a3b8" tick={{ fontSize: 12 }} />
                          <Radar dataKey="value" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.3} />
                          <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1f2a44" }} />
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </section>
              </>
            )}

            {/* Voice Intelligence Metrics */}
            {analytics?.voiceMetrics && (
              <section>
                <h2 style={{ margin: "0 0 1rem", fontSize: "1.3rem", fontWeight: 700, color: "#22d3ee" }}>Voice Intelligence</h2>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: "1rem",
                    marginBottom: "1.5rem",
                  }}
                >
                  {[
                    { label: "Confidence", value: `${analytics.voiceMetrics.avg_confidence_score}/10`, sub: "Proxy from audio" },
                    { label: "Vocal Clarity", value: `${analytics.voiceMetrics.avg_vocal_clarity_score}/10`, sub: "Speech recognition quality" },
                    { label: "Energy", value: `${analytics.voiceMetrics.avg_energy_score}/10`, sub: "Speaking engagement" },
                    { label: "Speaking Rate", value: `${analytics.voiceMetrics.avg_speaking_rate_wpm} wpm`, sub: "Words per minute" },
                    { label: "Hesitations", value: `${analytics.voiceMetrics.avg_hesitation_count}`, sub: `${analytics.voiceMetrics.avg_hesitation_rate}% of words` },
                    { label: "Avg Pause", value: `${(analytics.voiceMetrics.avg_pause_ms / 1000).toFixed(1)}s`, sub: "Between segments" },
                    { label: "Silence", value: `${(analytics.voiceMetrics.avg_silence_duration_ms / 1000).toFixed(1)}s`, sub: "Total per session" },
                    ...(analytics.voiceMetrics.avg_stt_confidence != null ? [{ label: "STT Confidence", value: `${(analytics.voiceMetrics.avg_stt_confidence * 100).toFixed(0)}%`, sub: "Deepgram recognition" }] : []),
                  ].map((item) => (
                    <div
                      key={item.label}
                      style={{
                        padding: "1.1rem",
                        borderRadius: "14px",
                        background: "rgba(15, 23, 42, 0.85)",
                        border: "1px solid rgba(34, 211, 238, 0.2)",
                      }}
                    >
                      <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.1em" }}>{item.label}</p>
                      <p style={{ margin: "0.4rem 0 0", fontSize: "1.5rem", fontWeight: 700, color: "#22d3ee" }}>{item.value}</p>
                      <p style={{ margin: "0.2rem 0 0", fontSize: "0.7rem", opacity: 0.5 }}>{item.sub}</p>
                    </div>
                  ))}
                </div>

                {/* Voice Quality Radar */}
                <div
                  style={{
                    padding: "1.5rem",
                    borderRadius: "18px",
                    background: "rgba(15, 23, 42, 0.85)",
                    border: "1px solid rgba(34, 211, 238, 0.15)",
                  }}
                >
                  <h2 style={{ margin: "0 0 1rem", fontSize: "1.2rem" }}>Voice Quality Profile</h2>
                  <div style={{ width: "100%", height: "280px" }}>
                    <ResponsiveContainer>
                      <RadarChart
                        data={[
                          { metric: "Confidence", value: analytics.voiceMetrics.avg_confidence_score },
                          { metric: "Clarity", value: analytics.voiceMetrics.avg_vocal_clarity_score },
                          { metric: "Energy", value: analytics.voiceMetrics.avg_energy_score },
                          { metric: "Fluency", value: Math.max(0, 10 - analytics.voiceMetrics.avg_hesitation_rate * 2) },
                          { metric: "Pacing", value: Math.min(10, analytics.voiceMetrics.avg_speaking_rate_wpm >= 120 && analytics.voiceMetrics.avg_speaking_rate_wpm <= 160 ? 10 : Math.max(0, 10 - Math.abs(analytics.voiceMetrics.avg_speaking_rate_wpm - 140) / 10)) },
                        ]}
                        outerRadius={90}
                      >
                        <PolarGrid stroke="#1f2a44" />
                        <PolarAngleAxis dataKey="metric" stroke="#94a3b8" tick={{ fontSize: 12 }} />
                        <Radar dataKey="value" stroke="#22d3ee" fill="#22d3ee" fillOpacity={0.3} />
                        <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1f2a44" }} />
                      </RadarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </section>
            )}
          </>
        )}

        <section
          style={{
            padding: "1.5rem",
            borderRadius: "18px",
            background: "rgba(15, 23, 42, 0.85)",
            border: "1px solid rgba(148, 163, 184, 0.15)",
          }}
        >
          <h2 style={{ margin: "0 0 1rem", fontSize: "1.2rem" }}>Session History</h2>
          {sessionLoading ? (
            <div style={{ opacity: 0.75 }}>Loading sessions...</div>
          ) : sessions.length === 0 ? (
            <div style={{ opacity: 0.75 }}>No sessions found.</div>
          ) : (
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {sessions.map((session) => (
                <div
                  key={session.id}
                  style={{
                    display: "grid",
                    gap: "0.6rem",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    alignItems: "center",
                    padding: "0.9rem",
                    borderRadius: "12px",
                    background: "rgba(2, 6, 23, 0.55)",
                    border: "1px solid rgba(148, 163, 184, 0.12)",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "0.85rem", opacity: 0.65 }}>Scenario</div>
                    <div style={{ fontWeight: 600 }}>{session.scenario}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "0.85rem", opacity: 0.65 }}>Date</div>
                    <div style={{ fontWeight: 600 }}>{new Date(session.created_at).toLocaleString()}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "0.85rem", opacity: 0.65 }}>Overall Score</div>
                    <div style={{ fontWeight: 600 }}>{session.overall_score ?? "N/A"}</div>
                  </div>
                  <button
                    onClick={() => downloadSessionReport(session.id)}
                    style={{
                      padding: "0.5rem 0.9rem",
                      borderRadius: "10px",
                      border: "1px solid rgba(255,255,255,0.2)",
                      background: "rgba(14, 165, 233, 0.2)",
                      color: "#e2e8f0",
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    Download Report
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
