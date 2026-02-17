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
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const API_BASE = "http://localhost:3001";

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

type TraineeAnalytics = {
  traineeId: string;
  traineeEmail: string;
  summary: AnalyticsSummary;
  trend: AnalyticsTrendPoint[];
  byScenario: AnalyticsScenario[];
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
