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

type TeamMember = {
  user_id: string;
  email: string;
  avgOverallScore: number;
  avgObjectionHandling: number;
  avgCommunicationClarity: number;
  avgConfidence: number;
  sessionCount: number;
};

type UnassignedUser = {
  user_id: string;
  email: string;
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
  const [role, setRole] = useState<string>("");
  const [organizationName, setOrganizationName] = useState<string>("");
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [unassignedUsers, setUnassignedUsers] = useState<UnassignedUser[]>([]);
  const [inviteEmail, setInviteEmail] = useState<string>("");
  const [inviteLoading, setInviteLoading] = useState<boolean>(false);
  const [teamLoading, setTeamLoading] = useState<boolean>(false);
  const [teamError, setTeamError] = useState<string>("");

  // Complaint modal state (trainer can file complaints against trainees)
  const [showComplaintModal, setShowComplaintModal] = useState(false);
  const [complaintSubject, setComplaintSubject] = useState("");
  const [complaintMessage, setComplaintMessage] = useState("");
  const [complaintAgainst, setComplaintAgainst] = useState("");
  const [complaintSending, setComplaintSending] = useState(false);
  const [complaintSuccess, setComplaintSuccess] = useState("");
  const [complaintError, setComplaintError] = useState("");

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
        const orgInfo = await fetchOrgInfo(authToken);
        setRole(orgInfo.role || "");
        setOrganizationName(orgInfo.organizationName || "");
        if (orgInfo.role === "trainer") {
          await loadTeamData(authToken);
          setLoading(false);
          return;
        }

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

  async function fetchOrgInfo(token: string) {
    const response = await fetch(`${API_BASE}/api/org/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Org lookup failed with ${response.status}`);
    }
    return response.json() as Promise<{
      role: string | null;
      organizationId: string | null;
      organizationName: string | null;
    }>;
  }

  async function loadTeamData(token: string) {
    setTeamLoading(true);
    setTeamError("");
    try {
      const [teamRes, unassignedRes] = await Promise.all([
        fetch(`${API_BASE}/api/org/team`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_BASE}/api/org/unassigned`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      if (!teamRes.ok) {
        throw new Error(`Team request failed with ${teamRes.status}`);
      }
      if (!unassignedRes.ok) {
        throw new Error(`Unassigned request failed with ${unassignedRes.status}`);
      }

      const teamPayload = await teamRes.json();
      const unassignedPayload = await unassignedRes.json();
      setTeamMembers(Array.isArray(teamPayload?.members) ? teamPayload.members : []);
      setUnassignedUsers(Array.isArray(unassignedPayload?.users) ? unassignedPayload.users : []);
    } catch (err) {
      console.error("Failed to load team data", err);
      setTeamError("Failed to load team data");
    } finally {
      setTeamLoading(false);
    }
  }

  async function handleInvite() {
    if (!authToken || !inviteEmail) return;
    setInviteLoading(true);
    setTeamError("");
    try {
      const response = await fetch(`${API_BASE}/api/org/assign`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: inviteEmail }),
      });
      if (!response.ok) {
        throw new Error(`Assign failed with ${response.status}`);
      }
      setInviteEmail("");
      await loadTeamData(authToken);
    } catch (err) {
      console.error("Failed to assign trainee", err);
      setTeamError("Failed to assign trainee");
    } finally {
      setInviteLoading(false);
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

  const teamChartData = useMemo(() => {
    return teamMembers.map((member) => ({
      name: member.email,
      avgOverallScore: Number(member.avgOverallScore.toFixed(2)),
    }));
  }, [teamMembers]);

  const leaderboard = useMemo(() => {
    return [...teamMembers].sort((a, b) => b.avgOverallScore - a.avgOverallScore);
  }, [teamMembers]);

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
            {role !== "trainer" && role !== "" && (
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
            )}
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
            {role === "trainer" && (
              <>
                <a
                  href="/messages"
                  style={{
                    marginLeft: "0.75rem",
                    padding: "0.45rem 0.85rem",
                    borderRadius: "999px",
                    border: "1px solid rgba(14,165,233,0.3)",
                    background: "rgba(14, 165, 233, 0.15)",
                    color: "#93c5fd",
                    textDecoration: "none",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                  }}
                >
                  Messages
                </a>
                <button
                  onClick={() => {
                    setShowComplaintModal(true);
                    setComplaintSubject("");
                    setComplaintMessage("");
                    setComplaintAgainst("");
                    setComplaintSuccess("");
                    setComplaintError("");
                  }}
                  style={{
                    marginLeft: "0.75rem",
                    padding: "0.45rem 0.85rem",
                    borderRadius: "999px",
                    border: "1px solid rgba(239,68,68,0.3)",
                    background: "rgba(239, 68, 68, 0.2)",
                    color: "#fca5a5",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                  }}
                >
                  Report Issue
                </button>
              </>
            )}
          </div>
        </header>

        {role === "trainer" && (
          <section
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "1.5rem",
              padding: "1.5rem",
              borderRadius: "18px",
              background: "rgba(15, 23, 42, 0.85)",
              border: "1px solid rgba(148, 163, 184, 0.15)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.75 }}>Team Dashboard</p>
              <h2 style={{ margin: 0, fontSize: "1.5rem" }}>{organizationName || "Your Organization"}</h2>
              {/* TODO: Add enterprise billing indicators. */}
              {/* TODO: Add org-level reporting overview. */}
              {/* TODO: Add team performance export controls. */}
            </div>

            <div style={{ display: "grid", gap: "0.75rem" }}>
              <label style={{ fontSize: "0.85rem", opacity: 0.8 }}>Assign trainee (unassigned users)</label>
              <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                <select
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  style={{
                    minWidth: "240px",
                    padding: "0.5rem 0.75rem",
                    borderRadius: "10px",
                    border: "1px solid rgba(148, 163, 184, 0.3)",
                    background: "rgba(15, 23, 42, 0.6)",
                    color: "#e2e8f0",
                  }}
                >
                  <option value="">Select trainee</option>
                  {unassignedUsers.map((user) => (
                    <option key={user.user_id} value={user.email}>
                      {user.email}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleInvite}
                  disabled={!inviteEmail || inviteLoading}
                  style={{
                    padding: "0.5rem 1rem",
                    borderRadius: "10px",
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: inviteLoading ? "#475569" : "rgba(34, 197, 94, 0.2)",
                    color: "#e2e8f0",
                    cursor: inviteLoading ? "not-allowed" : "pointer",
                    fontWeight: 600,
                  }}
                >
                  {inviteLoading ? "Assigning..." : "Assign Trainee"}
                </button>
              </div>
            </div>

            {teamLoading && (
              <div style={{ padding: "1rem", borderRadius: "12px", background: "rgba(15, 23, 42, 0.7)" }}>
                Loading team data...
              </div>
            )}

            {teamError && (
              <div style={{ padding: "1rem", borderRadius: "12px", background: "rgba(239, 68, 68, 0.15)" }}>
                {teamError}
              </div>
            )}

            {!teamLoading && teamMembers.length === 0 && (
              <div style={{ padding: "1rem", borderRadius: "12px", background: "rgba(15, 23, 42, 0.7)" }}>
                No trainees assigned yet.
              </div>
            )}

            {!teamLoading && teamMembers.length > 0 && (
              <>
                <div style={{ width: "100%", height: "260px" }}>
                  <ResponsiveContainer>
                    <BarChart data={teamChartData} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2a44" />
                      <XAxis dataKey="name" stroke="#94a3b8" tick={{ fontSize: 11 }} interval={0} />
                      <YAxis domain={[0, 10]} stroke="#94a3b8" tick={{ fontSize: 12 }} />
                      <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1f2a44" }} />
                      <Bar dataKey="avgOverallScore" fill="#38bdf8" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1rem" }}>
                  <div style={{ padding: "1rem", borderRadius: "12px", background: "rgba(15, 23, 42, 0.7)" }}>
                    <h3 style={{ margin: "0 0 0.75rem", fontSize: "1.05rem" }}>Leaderboard</h3>
                    <ol style={{ margin: 0, paddingLeft: "1.25rem" }}>
                      {leaderboard.map((member) => (
                        <li key={member.user_id} style={{ marginBottom: "0.4rem" }}>
                          {member.email} — {member.avgOverallScore.toFixed(2)}
                        </li>
                      ))}
                    </ol>
                  </div>

                  <div style={{ padding: "1rem", borderRadius: "12px", background: "rgba(15, 23, 42, 0.7)" }}>
                    <h3 style={{ margin: "0 0 0.75rem", fontSize: "1.05rem" }}>Trainee Summary</h3>
                    <div style={{ display: "grid", gap: "0.6rem" }}>
                      {teamMembers.map((member) => (
                        <div key={member.user_id} style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                          <strong>{member.email}</strong>
                          <span style={{ fontSize: "0.85rem", opacity: 0.75 }}>
                            Sessions: {member.sessionCount} · Overall {member.avgOverallScore.toFixed(2)} · Objection {member.avgObjectionHandling.toFixed(2)} · Clarity {member.avgCommunicationClarity.toFixed(2)} · Confidence {member.avgConfidence.toFixed(2)}
                          </span>
                          <Link
                            href={`/analytics/trainee/${member.user_id}`}
                            style={{
                              fontSize: "0.85rem",
                              color: "#7dd3fc",
                              textDecoration: "none",
                              fontWeight: 600,
                            }}
                          >
                            View detailed analytics
                          </Link>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              </>
            )}
          </section>
        )}

        {role !== "trainer" && loading && (
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

        {role !== "trainer" && !loading && error && (
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

        {role !== "trainer" && !loading && !error && !hasData && (
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

        {role !== "trainer" && !loading && !error && hasData && summary && (
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

      {/* Complaint Modal for Trainers */}
      {showComplaintModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
          onClick={() => setShowComplaintModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "90%",
              maxWidth: "500px",
              padding: "2rem",
              borderRadius: "18px",
              background: "#0f172a",
              border: "1px solid rgba(239,68,68,0.25)",
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
            }}
          >
            <h2 style={{ margin: 0, fontSize: "1.3rem", fontWeight: 700, color: "#fca5a5" }}>Report Issue to Admin</h2>
            <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.65 }}>File a complaint about a trainee. This will be sent to the administrator.</p>
            {teamMembers.length > 0 && (
              <select
                value={complaintAgainst}
                onChange={(e) => setComplaintAgainst(e.target.value)}
                style={{
                  padding: "0.6rem 0.9rem",
                  borderRadius: "10px",
                  border: "1px solid rgba(148,163,184,0.2)",
                  background: "rgba(2,6,23,0.6)",
                  color: "#e2e8f0",
                  fontSize: "0.9rem",
                }}
              >
                <option value="">Select trainee (optional)</option>
                {teamMembers.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{m.email}</option>
                ))}
              </select>
            )}
            <input
              type="text"
              value={complaintSubject}
              onChange={(e) => setComplaintSubject(e.target.value)}
              placeholder="Subject"
              style={{
                padding: "0.6rem 0.9rem",
                borderRadius: "10px",
                border: "1px solid rgba(148,163,184,0.2)",
                background: "rgba(2,6,23,0.6)",
                color: "#e2e8f0",
                fontSize: "0.9rem",
                outline: "none",
              }}
            />
            <textarea
              value={complaintMessage}
              onChange={(e) => setComplaintMessage(e.target.value)}
              placeholder="Describe the issue..."
              rows={4}
              style={{
                padding: "0.6rem 0.9rem",
                borderRadius: "10px",
                border: "1px solid rgba(148,163,184,0.2)",
                background: "rgba(2,6,23,0.6)",
                color: "#e2e8f0",
                fontSize: "0.9rem",
                resize: "vertical",
                outline: "none",
              }}
            />
            {complaintError && <p style={{ margin: 0, color: "#fca5a5", fontSize: "0.85rem" }}>{complaintError}</p>}
            {complaintSuccess && <p style={{ margin: 0, color: "#86efac", fontSize: "0.85rem" }}>{complaintSuccess}</p>}
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowComplaintModal(false)}
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: "10px",
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "transparent",
                  color: "#e2e8f0",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!complaintSubject.trim() || !complaintMessage.trim()) {
                    setComplaintError("Subject and message are required.");
                    return;
                  }
                  setComplaintSending(true);
                  setComplaintError("");
                  try {
                    const body: Record<string, string> = {
                      subject: complaintSubject.trim(),
                      message: complaintMessage.trim(),
                    };
                    if (complaintAgainst) body.againstUserId = complaintAgainst;
                    const res = await fetch(`${API_BASE}/api/complaints`, {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${authToken}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify(body),
                    });
                    if (!res.ok) throw new Error("Failed");
                    setComplaintSuccess("Complaint submitted successfully!");
                    setComplaintSubject("");
                    setComplaintMessage("");
                    setComplaintAgainst("");
                    setTimeout(() => setShowComplaintModal(false), 1500);
                  } catch {
                    setComplaintError("Failed to submit complaint. Please try again.");
                  } finally {
                    setComplaintSending(false);
                  }
                }}
                disabled={complaintSending}
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: "10px",
                  border: "none",
                  background: complaintSending ? "#374151" : "#ef4444",
                  color: "white",
                  cursor: complaintSending ? "not-allowed" : "pointer",
                  fontWeight: 600,
                }}
              >
                {complaintSending ? "Sending..." : "Submit Complaint"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
