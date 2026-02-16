"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";
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

type AnalyticsResponse = {
  summary: AnalyticsSummary;
  trend: AnalyticsTrendPoint[];
  byScenario: AnalyticsScenario[];
};

const API_BASE = "http://localhost:3001";

export default function AnalyticsPage() {
  const router = useRouter();
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [authEmail, setAuthEmail] = useState<string>("");
  const [authToken, setAuthToken] = useState<string>("");

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data: authData }) => {
      if (!active) return;
      const session = authData.session;
      if (!session) {
        setAuthLoading(false);
        router.push("/login");
        return;
      }
      setAuthEmail(session.user.email || "");
      setAuthToken(session.access_token);
      setAuthLoading(false);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setAuthToken("");
        setAuthLoading(false);
        router.push("/login");
        return;
      }
      setAuthEmail(session.user.email || "");
      setAuthToken(session.access_token);
      setAuthLoading(false);
    });

    async function fetchAnalytics() {
      if (!authToken) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");

      try {
        const response = await fetch(`${API_BASE}/api/analytics`, {
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });
        if (!response.ok) {
          throw new Error(`Request failed with ${response.status}`);
        }
        const payload = (await response.json()) as AnalyticsResponse;
        if (active) {
          setData(payload);
        }
      } catch (err) {
        console.error("Failed to load analytics", err);
        if (active) {
          setError("Failed to load analytics");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    fetchAnalytics();

    return () => {
      active = false;
      authListener?.subscription.unsubscribe();
    };
  }, [authToken, router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  async function downloadAnalyticsReport() {
    if (!authToken) {
      router.push("/login");
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/api/report/analytics`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "performance-analytics-report.pdf";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to download analytics report", err);
      setError("Failed to download analytics report");
    }
  }

  const trendData = useMemo(() => {
    if (!data?.trend) return [];
    return data.trend
      .filter((point) => typeof point.overall_score === "number")
      .map((point) => ({
        date: new Date(point.created_at).toLocaleDateString(),
        overall_score: Number(point.overall_score),
      }));
  }, [data]);

  const scenarioData = useMemo(() => {
    if (!data?.byScenario) return [];
    return data.byScenario.map((entry) => ({
      scenario: entry.scenario,
      avgOverallScore: Number(entry.avgOverallScore.toFixed(2)),
      count: entry.count,
    }));
  }, [data]);

  const radarData = useMemo(() => {
    if (!data?.summary) return [];
    return [
      { skill: "Overall", score: Number(data.summary.avgOverallScore.toFixed(2)) },
      { skill: "Objection", score: Number(data.summary.avgObjectionHandling.toFixed(2)) },
      { skill: "Clarity", score: Number(data.summary.avgCommunicationClarity.toFixed(2)) },
      { skill: "Confidence", score: Number(data.summary.avgConfidence.toFixed(2)) },
    ];
  }, [data]);

  const summary = data?.summary;
  const hasData = summary && summary.totalSessions > 0;

  if (authLoading) {
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
        Loading...
      </main>
    );
  }

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
      <div
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: "2rem",
        }}
      >
        <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <p style={{ margin: 0, textTransform: "uppercase", letterSpacing: "0.2em", fontSize: "0.75rem" }}>
            Performance Analytics
          </p>
          <h1 style={{ margin: 0, fontSize: "2.4rem", fontWeight: 700 }}>
            Trainee Performance Dashboard
          </h1>
          <p style={{ margin: 0, fontSize: "1rem", opacity: 0.8 }}>
            Track call quality and coaching outcomes over time.
          </p>
          <div style={{ marginTop: "0.5rem" }}>
            <Link
              href="/"
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
              Back to Call
            </Link>
            <button
              onClick={handleLogout}
              style={{
                marginLeft: "0.75rem",
                padding: "0.45rem 0.85rem",
                borderRadius: "999px",
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(239, 68, 68, 0.2)",
                color: "#e2e8f0",
                cursor: "pointer",
                fontSize: "0.85rem",
                fontWeight: 600,
              }}
            >
              Log Out
            </button>
            <button
              onClick={downloadAnalyticsReport}
              style={{
                marginLeft: "0.75rem",
                padding: "0.45rem 0.85rem",
                borderRadius: "999px",
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(14, 165, 233, 0.2)",
                color: "#e2e8f0",
                cursor: "pointer",
                fontSize: "0.85rem",
                fontWeight: 600,
              }}
            >
              Download Report
            </button>
            {authEmail && (
              <span style={{ marginLeft: "0.75rem", fontSize: "0.8rem", opacity: 0.75 }}>{authEmail}</span>
            )}
          </div>
        </header>

        {loading && (
          <div
            style={{
              padding: "1.5rem",
              borderRadius: "16px",
              background: "rgba(15, 23, 42, 0.7)",
              border: "1px solid rgba(148, 163, 184, 0.15)",
            }}
          >
            Loading analytics...
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
          <div
            style={{
              padding: "1.5rem",
              borderRadius: "16px",
              background: "rgba(15, 23, 42, 0.7)",
              border: "1px solid rgba(148, 163, 184, 0.15)",
            }}
          >
            No completed sessions yet. Finish a call to see analytics.
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

            <section
              style={{
                padding: "1.5rem",
                borderRadius: "18px",
                background: "rgba(15, 23, 42, 0.85)",
                border: "1px solid rgba(148, 163, 184, 0.15)",
              }}
            >
              <h2 style={{ margin: "0 0 1rem", fontSize: "1.2rem" }}>Skill Breakdown</h2>
              <div style={{ width: "100%", height: "260px" }}>
                <ResponsiveContainer>
                  <RadarChart data={radarData} outerRadius={90}>
                    <PolarGrid stroke="#1f2a44" />
                    <PolarAngleAxis dataKey="skill" stroke="#94a3b8" tick={{ fontSize: 12 }} />
                    <Radar dataKey="score" stroke="#38bdf8" fill="#38bdf8" fillOpacity={0.35} />
                    <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1f2a44" }} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
