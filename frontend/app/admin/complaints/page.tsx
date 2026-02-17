"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "../../../lib/supabaseClient";

const API_BASE = "http://localhost:3001";

type Complaint = {
  id: string;
  filed_by: string;
  filed_by_email: string;
  filed_by_role: string;
  against_user_id: string | null;
  against_user_email: string | null;
  organization_id: string | null;
  organizationName: string;
  subject: string;
  message: string;
  status: string;
  admin_response: string | null;
  created_at: string;
  updated_at: string;
};

type OrgOption = {
  id: string;
  name: string;
};

const STATUS_OPTIONS = ["open", "in_progress", "resolved", "closed"];
const STATUS_COLORS: Record<string, string> = {
  open: "#f59e0b",
  in_progress: "#3b82f6",
  resolved: "#22c55e",
  closed: "#6b7280",
};

export default function AdminComplaintsPage() {
  const router = useRouter();

  const [authToken, setAuthToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);

  // Filters
  const [filterOrg, setFilterOrg] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  // Responding to a complaint
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [responseText, setResponseText] = useState("");
  const [responseStatus, setResponseStatus] = useState("");
  const [saving, setSaving] = useState(false);

  // Auth
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

  // Verify admin
  useEffect(() => {
    if (!authToken) return;
    let active = true;

    async function checkAdmin() {
      try {
        const res = await fetch(`${API_BASE}/api/admin/me`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) {
          router.push("/");
          return;
        }
        const data = await res.json();
        if (!data.isAdmin) {
          router.push("/");
        }
      } catch {
        router.push("/");
      }
    }

    checkAdmin();
    return () => {
      active = false;
    };
  }, [authToken, router]);

  // Load orgs
  useEffect(() => {
    if (!authToken) return;
    async function loadOrgs() {
      try {
        const res = await fetch(`${API_BASE}/api/admin/orgs`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          setOrgs(data.organizations || []);
        }
      } catch {
        // ignore
      }
    }
    loadOrgs();
  }, [authToken]);

  // Load complaints
  const loadComplaints = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterOrg) params.set("organization_id", filterOrg);
      if (filterStatus) params.set("status", filterStatus);

      const res = await fetch(`${API_BASE}/api/admin/complaints?${params.toString()}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setComplaints(data.complaints || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [authToken, filterOrg, filterStatus]);

  useEffect(() => {
    loadComplaints();
  }, [loadComplaints]);

  async function handleRespond(complaintId: string) {
    if (saving) return;
    setSaving(true);
    try {
      const body: Record<string, string> = {};
      if (responseStatus) body.status = responseStatus;
      if (responseText.trim()) body.admin_response = responseText.trim();

      const res = await fetch(`${API_BASE}/api/admin/complaints/${complaintId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setRespondingId(null);
        setResponseText("");
        setResponseStatus("");
        loadComplaints();
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  // Group complaints by org
  const grouped = complaints.reduce((acc, c) => {
    const key = c.organizationName || "No Organization";
    if (!acc[key]) acc[key] = [];
    acc[key].push(c);
    return acc;
  }, {} as Record<string, Complaint[]>);

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "2rem",
        background: "linear-gradient(135deg, #0b1220, #12203a)",
        color: "#e2e8f0",
        fontFamily: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ maxWidth: "1200px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        {/* Header */}
        <header style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <Link
            href="/admin"
            style={{
              padding: "0.4rem 0.75rem",
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(148,163,184,0.15)",
              color: "#e2e8f0",
              textDecoration: "none",
              fontSize: "0.82rem",
              fontWeight: 600,
            }}
          >
            Back to Admin
          </Link>
          <h1 style={{ margin: 0, fontSize: "1.8rem", fontWeight: 700, flex: 1 }}>Complaints</h1>
          <button
            onClick={handleLogout}
            style={{
              padding: "0.4rem 0.75rem",
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(239, 68, 68, 0.2)",
              color: "#e8eef5",
              cursor: "pointer",
              fontSize: "0.82rem",
              fontWeight: 600,
            }}
          >
            Log Out
          </button>
        </header>

        {/* Filters */}
        <div
          style={{
            display: "flex",
            gap: "1rem",
            flexWrap: "wrap",
            padding: "1rem",
            borderRadius: "14px",
            background: "rgba(15, 23, 42, 0.7)",
            border: "1px solid rgba(148,163,184,0.15)",
          }}
        >
          <div>
            <label style={{ fontSize: "0.78rem", opacity: 0.7, display: "block", marginBottom: "0.3rem" }}>
              Organization
            </label>
            <select
              value={filterOrg}
              onChange={(e) => setFilterOrg(e.target.value)}
              style={{
                padding: "0.4rem 0.6rem",
                borderRadius: "8px",
                border: "1px solid rgba(148,163,184,0.2)",
                background: "rgba(2,6,23,0.6)",
                color: "#e2e8f0",
                fontSize: "0.85rem",
              }}
            >
              <option value="">All Organizations</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: "0.78rem", opacity: 0.7, display: "block", marginBottom: "0.3rem" }}>
              Status
            </label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              style={{
                padding: "0.4rem 0.6rem",
                borderRadius: "8px",
                border: "1px solid rgba(148,163,184,0.2)",
                background: "rgba(2,6,23,0.6)",
                color: "#e2e8f0",
                fontSize: "0.85rem",
              }}
            >
              <option value="">All Statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button
              onClick={loadComplaints}
              style={{
                padding: "0.45rem 0.85rem",
                borderRadius: "8px",
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(14,165,233,0.25)",
                color: "#e2e8f0",
                cursor: "pointer",
                fontSize: "0.85rem",
                fontWeight: 600,
              }}
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Summary cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "0.75rem" }}>
          {STATUS_OPTIONS.map((s) => {
            const count = complaints.filter((c) => c.status === s).length;
            return (
              <div
                key={s}
                style={{
                  padding: "1rem",
                  borderRadius: "14px",
                  background: "rgba(15, 23, 42, 0.85)",
                  border: `1px solid ${STATUS_COLORS[s]}40`,
                  textAlign: "center",
                }}
              >
                <p style={{ margin: 0, fontSize: "1.6rem", fontWeight: 700, color: STATUS_COLORS[s] }}>{count}</p>
                <p style={{ margin: "0.3rem 0 0", fontSize: "0.78rem", opacity: 0.7 }}>
                  {s.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                </p>
              </div>
            );
          })}
        </div>

        {/* Complaints grouped by org */}
        {loading ? (
          <p style={{ opacity: 0.5 }}>Loading complaints...</p>
        ) : complaints.length === 0 ? (
          <div
            style={{
              padding: "2rem",
              borderRadius: "14px",
              background: "rgba(15, 23, 42, 0.7)",
              textAlign: "center",
              opacity: 0.5,
            }}
          >
            No complaints found.
          </div>
        ) : (
          Object.entries(grouped).map(([orgName, orgComplaints]) => (
            <section key={orgName}>
              <h2
                style={{
                  fontSize: "1.1rem",
                  fontWeight: 600,
                  margin: "0 0 0.75rem",
                  padding: "0.5rem 0",
                  borderBottom: "1px solid rgba(148,163,184,0.15)",
                }}
              >
                {orgName} ({orgComplaints.length})
              </h2>
              <div style={{ display: "grid", gap: "0.75rem" }}>
                {orgComplaints.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      padding: "1.25rem",
                      borderRadius: "14px",
                      background: "rgba(15, 23, 42, 0.85)",
                      border: `1px solid ${STATUS_COLORS[c.status] || "#6b7280"}30`,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem" }}>
                      <div>
                        <h3 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600 }}>{c.subject}</h3>
                        <p style={{ margin: "0.3rem 0 0", fontSize: "0.82rem", opacity: 0.65 }}>
                          Filed by: <strong>{c.filed_by_email}</strong> ({c.filed_by_role})
                          {c.against_user_email && (
                            <> · Against: <strong>{c.against_user_email}</strong></>
                          )}
                        </p>
                      </div>
                      <span
                        style={{
                          padding: "0.25rem 0.65rem",
                          borderRadius: "999px",
                          background: `${STATUS_COLORS[c.status] || "#6b7280"}25`,
                          color: STATUS_COLORS[c.status] || "#6b7280",
                          fontSize: "0.75rem",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {c.status.replace("_", " ")}
                      </span>
                    </div>

                    <p
                      style={{
                        margin: "0.75rem 0 0",
                        fontSize: "0.9rem",
                        lineHeight: 1.5,
                        padding: "0.75rem",
                        borderRadius: "10px",
                        background: "rgba(2,6,23,0.5)",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {c.message}
                    </p>

                    {c.admin_response && (
                      <div
                        style={{
                          margin: "0.75rem 0 0",
                          padding: "0.75rem",
                          borderRadius: "10px",
                          background: "rgba(14,165,233,0.1)",
                          border: "1px solid rgba(14,165,233,0.2)",
                        }}
                      >
                        <p style={{ margin: 0, fontSize: "0.78rem", fontWeight: 600, opacity: 0.7 }}>Admin Response:</p>
                        <p style={{ margin: "0.3rem 0 0", fontSize: "0.88rem", whiteSpace: "pre-wrap" }}>
                          {c.admin_response}
                        </p>
                      </div>
                    )}

                    <div style={{ margin: "0.75rem 0 0", display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "0.72rem", opacity: 0.4 }}>
                        {new Date(c.created_at).toLocaleString()}
                      </span>
                      <div style={{ flex: 1 }} />

                      {respondingId === c.id ? (
                        <div style={{ width: "100%", marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                          <select
                            value={responseStatus}
                            onChange={(e) => setResponseStatus(e.target.value)}
                            style={{
                              padding: "0.4rem 0.6rem",
                              borderRadius: "8px",
                              border: "1px solid rgba(148,163,184,0.2)",
                              background: "rgba(2,6,23,0.6)",
                              color: "#e2e8f0",
                              fontSize: "0.85rem",
                            }}
                          >
                            <option value="">Keep current status</option>
                            {STATUS_OPTIONS.map((s) => (
                              <option key={s} value={s}>
                                {s.replace("_", " ").replace(/\b\w/g, (ch) => ch.toUpperCase())}
                              </option>
                            ))}
                          </select>
                          <textarea
                            value={responseText}
                            onChange={(e) => setResponseText(e.target.value)}
                            placeholder="Write an admin response..."
                            rows={3}
                            style={{
                              padding: "0.6rem",
                              borderRadius: "10px",
                              border: "1px solid rgba(148,163,184,0.2)",
                              background: "rgba(2,6,23,0.6)",
                              color: "#e2e8f0",
                              fontSize: "0.85rem",
                              resize: "vertical",
                            }}
                          />
                          <div style={{ display: "flex", gap: "0.5rem" }}>
                            <button
                              onClick={() => handleRespond(c.id)}
                              disabled={saving}
                              style={{
                                padding: "0.45rem 0.85rem",
                                borderRadius: "8px",
                                border: "none",
                                background: saving ? "#374151" : "#0ea5e9",
                                color: "white",
                                cursor: saving ? "not-allowed" : "pointer",
                                fontWeight: 600,
                                fontSize: "0.82rem",
                              }}
                            >
                              {saving ? "Saving..." : "Save"}
                            </button>
                            <button
                              onClick={() => {
                                setRespondingId(null);
                                setResponseText("");
                                setResponseStatus("");
                              }}
                              style={{
                                padding: "0.45rem 0.85rem",
                                borderRadius: "8px",
                                border: "1px solid rgba(255,255,255,0.2)",
                                background: "transparent",
                                color: "#e2e8f0",
                                cursor: "pointer",
                                fontSize: "0.82rem",
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                          {/* Quick status buttons */}
                          {STATUS_OPTIONS.filter((s) => s !== c.status).map((s) => (
                            <button
                              key={s}
                              onClick={async () => {
                                try {
                                  await fetch(`${API_BASE}/api/admin/complaints/${c.id}`, {
                                    method: "PATCH",
                                    headers: {
                                      Authorization: `Bearer ${authToken}`,
                                      "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({ status: s }),
                                  });
                                  loadComplaints();
                                } catch {
                                  // ignore
                                }
                              }}
                              style={{
                                padding: "0.3rem 0.6rem",
                                borderRadius: "6px",
                                border: `1px solid ${STATUS_COLORS[s]}40`,
                                background: `${STATUS_COLORS[s]}15`,
                                color: STATUS_COLORS[s],
                                cursor: "pointer",
                                fontSize: "0.72rem",
                                fontWeight: 600,
                              }}
                            >
                              Mark {s.replace("_", " ").replace(/\b\w/g, (ch) => ch.toUpperCase())}
                            </button>
                          ))}
                          <button
                            onClick={() => {
                              setRespondingId(c.id);
                              setResponseText(c.admin_response || "");
                              setResponseStatus(c.status);
                            }}
                            style={{
                              padding: "0.35rem 0.7rem",
                              borderRadius: "8px",
                              border: "1px solid rgba(255,255,255,0.2)",
                              background: "rgba(14,165,233,0.2)",
                              color: "#e2e8f0",
                              cursor: "pointer",
                              fontSize: "0.8rem",
                              fontWeight: 600,
                            }}
                          >
                            Respond
                          </button>
                          <Link
                            href={`/messages`}
                            style={{
                              padding: "0.35rem 0.7rem",
                              borderRadius: "8px",
                              border: "1px solid rgba(255,255,255,0.2)",
                              background: "rgba(148,163,184,0.15)",
                              color: "#e2e8f0",
                              textDecoration: "none",
                              fontSize: "0.8rem",
                              fontWeight: 600,
                            }}
                          >
                            Open Chat
                          </Link>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </main>
  );
}
