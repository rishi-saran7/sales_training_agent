"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";

const API_BASE = "http://localhost:3001";

type TrainerRow = {
  user_id: string;
  email: string;
  organization_id: string;
  organization_name: string;
  role: string;
};

type OrgRow = {
  id: string;
  name: string;
  created_at: string;
};

type TrainerEdits = Record<string, { email?: string; password?: string; orgId?: string }>;

type OrgEdits = Record<string, { name?: string }>;

export default function AdminPage() {
  const router = useRouter();
  const [authToken, setAuthToken] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [trainers, setTrainers] = useState<TrainerRow[]>([]);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [createEmail, setCreateEmail] = useState<string>("");
  const [createOrgName, setCreateOrgName] = useState<string>("");
  const [createOrgId, setCreateOrgId] = useState<string>("");
  const [createPassword, setCreatePassword] = useState<string>("");
  const [showCreatePassword, setShowCreatePassword] = useState<boolean>(false);
  const [createOrgOnly, setCreateOrgOnly] = useState<string>("");
  const [trainerEdits, setTrainerEdits] = useState<TrainerEdits>({});
  const [orgEdits, setOrgEdits] = useState<OrgEdits>({});
  const [busy, setBusy] = useState<string>("");

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
    if (!authToken) return;
    let active = true;

    async function boot() {
      setLoading(true);
      setError("");
      try {
        const adminRes = await fetch(`${API_BASE}/api/admin/me`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!adminRes.ok) {
          router.push("/analytics");
          return;
        }
        const [trainerRes, orgRes] = await Promise.all([
          fetch(`${API_BASE}/api/admin/trainers`, {
            headers: { Authorization: `Bearer ${authToken}` },
          }),
          fetch(`${API_BASE}/api/admin/orgs`, {
            headers: { Authorization: `Bearer ${authToken}` },
          }),
        ]);

        if (!trainerRes.ok || !orgRes.ok) {
          throw new Error("Failed to load admin data");
        }

        const trainerPayload = await trainerRes.json();
        const orgPayload = await orgRes.json();
        if (!active) return;
        setTrainers(Array.isArray(trainerPayload?.trainers) ? trainerPayload.trainers : []);
        setOrgs(Array.isArray(orgPayload?.organizations) ? orgPayload.organizations : []);
      } catch (err) {
        console.error("Failed to load admin data", err);
        if (active) setError("Failed to load admin data");
      } finally {
        if (active) setLoading(false);
      }
    }

    boot();

    return () => {
      active = false;
    };
  }, [authToken, router]);

  function updateTrainerEdit(userId: string, key: "email" | "password" | "orgId", value: string) {
    setTrainerEdits((prev) => ({
      ...prev,
      [userId]: { ...prev[userId], [key]: value },
    }));
  }

  function updateOrgEdit(orgId: string, value: string) {
    setOrgEdits((prev) => ({
      ...prev,
      [orgId]: { ...prev[orgId], name: value },
    }));
  }

  async function refresh() {
    if (!authToken) return;
    setBusy("refresh");
    setError("");
    try {
      const [trainerRes, orgRes] = await Promise.all([
        fetch(`${API_BASE}/api/admin/trainers`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }),
        fetch(`${API_BASE}/api/admin/orgs`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }),
      ]);
      if (!trainerRes.ok || !orgRes.ok) {
        throw new Error("Failed to refresh");
      }
      const trainerPayload = await trainerRes.json();
      const orgPayload = await orgRes.json();
      setTrainers(Array.isArray(trainerPayload?.trainers) ? trainerPayload.trainers : []);
      setOrgs(Array.isArray(orgPayload?.organizations) ? orgPayload.organizations : []);
    } catch (err) {
      console.error("Failed to refresh admin data", err);
      setError("Failed to refresh admin data");
    } finally {
      setBusy("");
    }
  }

  async function handleCreateTrainer() {
    if (!authToken || !createEmail) return;
    setBusy("create-trainer");
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/trainers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: createEmail,
          orgName: createOrgName,
          organizationId: createOrgId,
          password: createPassword,
        }),
      });
      if (!res.ok) {
        throw new Error(`Create trainer failed (${res.status})`);
      }
      setCreateEmail("");
      setCreateOrgName("");
      setCreateOrgId("");
      setCreatePassword("");
      await refresh();
    } catch (err) {
      console.error("Failed to create trainer", err);
      setError("Failed to create trainer");
    } finally {
      setBusy("");
    }
  }

  async function handleUpdateUser(userId: string) {
    if (!authToken) return;
    const edits = trainerEdits[userId] || {};
    if (!edits.email && !edits.password) return;

    setBusy(`update-user-${userId}`);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: edits.email, password: edits.password }),
      });
      if (!res.ok) {
        throw new Error(`Update user failed (${res.status})`);
      }
      setTrainerEdits((prev) => ({ ...prev, [userId]: { ...prev[userId], password: "" } }));
      await refresh();
    } catch (err) {
      console.error("Failed to update user", err);
      setError("Failed to update user");
    } finally {
      setBusy("");
    }
  }

  async function handleMoveTrainer(userId: string) {
    if (!authToken) return;
    const edits = trainerEdits[userId];
    if (!edits?.orgId) return;

    setBusy(`move-trainer-${userId}`);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/trainers/${userId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organizationId: edits.orgId }),
      });
      if (!res.ok) {
        throw new Error(`Move trainer failed (${res.status})`);
      }
      await refresh();
    } catch (err) {
      console.error("Failed to move trainer", err);
      setError("Failed to move trainer");
    } finally {
      setBusy("");
    }
  }

  async function handleRemoveTrainer(userId: string) {
    if (!authToken) return;
    const confirmed = window.confirm("Remove trainer role? The user account will remain active.");
    if (!confirmed) return;

    setBusy(`remove-trainer-${userId}`);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/trainers/${userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        throw new Error(`Remove trainer failed (${res.status})`);
      }
      await refresh();
    } catch (err) {
      console.error("Failed to remove trainer", err);
      setError("Failed to remove trainer");
    } finally {
      setBusy("");
    }
  }

  async function handleDisableUser(userId: string, enable: boolean) {
    if (!authToken) return;
    const action = enable ? "enable" : "disable";
    const confirmed = window.confirm(`Are you sure you want to ${action} this account?`);
    if (!confirmed) return;

    setBusy(`${action}-${userId}`);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/users/${userId}/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        throw new Error(`${action} failed (${res.status})`);
      }
      await refresh();
    } catch (err) {
      console.error(`Failed to ${action} user`, err);
      setError(`Failed to ${action} user`);
    } finally {
      setBusy("");
    }
  }

  async function handleCreateOrg() {
    if (!authToken || !createOrgOnly) return;
    setBusy("create-org");
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/orgs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: createOrgOnly }),
      });
      if (!res.ok) {
        throw new Error(`Create org failed (${res.status})`);
      }
      setCreateOrgOnly("");
      await refresh();
    } catch (err) {
      console.error("Failed to create organization", err);
      setError("Failed to create organization");
    } finally {
      setBusy("");
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  async function handleRenameOrg(orgId: string) {
    if (!authToken) return;
    const edits = orgEdits[orgId];
    if (!edits?.name) return;

    setBusy(`rename-org-${orgId}`);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/orgs/${orgId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: edits.name }),
      });
      if (!res.ok) {
        throw new Error(`Rename org failed (${res.status})`);
      }
      await refresh();
    } catch (err) {
      console.error("Failed to rename organization", err);
      setError("Failed to rename organization");
    } finally {
      setBusy("");
    }
  }

  async function handleDeleteOrg(orgId: string) {
    if (!authToken) return;
    const confirmed = window.confirm("Delete this organization and all memberships?");
    if (!confirmed) return;

    setBusy(`delete-org-${orgId}`);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/orgs/${orgId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        throw new Error(`Delete org failed (${res.status})`);
      }
      await refresh();
    } catch (err) {
      console.error("Failed to delete organization", err);
      setError("Failed to delete organization");
    } finally {
      setBusy("");
    }
  }

  const sortedOrgs = useMemo(() => {
    return [...orgs].sort((a, b) => a.name.localeCompare(b.name));
  }, [orgs]);

  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "3.5rem 1.5rem 4rem",
        background:
          "radial-gradient(circle at top, rgba(59, 130, 246, 0.2), transparent 55%), linear-gradient(135deg, #0b1220, #121b33)",
        color: "#e2e8f0",
        fontFamily: "'Space Grotesk', system-ui, -apple-system, sans-serif",
      }}
    >
      <section style={{ maxWidth: "1100px", margin: "0 auto" }}>
        <header style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <p style={{ textTransform: "uppercase", letterSpacing: "0.2em", fontSize: "0.7rem", opacity: 0.7 }}>
              Admin Console
            </p>
            <h1 style={{ margin: "0.4rem 0", fontSize: "2.6rem" }}>Sales Agent Control Room</h1>
            <p style={{ margin: 0, opacity: 0.7, maxWidth: "540px" }}>
              Create trainers, manage organizations, and control account access.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <button
              onClick={refresh}
              disabled={busy === "refresh"}
              style={{
                padding: "0.65rem 1.2rem",
                borderRadius: "999px",
                border: "1px solid rgba(148, 163, 184, 0.2)",
                background: "rgba(15, 23, 42, 0.8)",
                color: "#e2e8f0",
                cursor: busy === "refresh" ? "not-allowed" : "pointer",
              }}
            >
              {busy === "refresh" ? "Refreshing..." : "Refresh"}
            </button>
            <button
              onClick={handleLogout}
              style={{
                padding: "0.65rem 1.2rem",
                borderRadius: "999px",
                border: "1px solid rgba(248, 113, 113, 0.4)",
                background: "rgba(127, 29, 29, 0.6)",
                color: "#fecaca",
                cursor: "pointer",
              }}
            >
              Log out
            </button>
            <a
              href="/messages"
              style={{
                padding: "0.65rem 1.2rem",
                borderRadius: "999px",
                border: "1px solid rgba(14,165,233,0.3)",
                background: "rgba(14, 165, 233, 0.15)",
                color: "#93c5fd",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              Messages
            </a>
            <a
              href="/admin/complaints"
              style={{
                padding: "0.65rem 1.2rem",
                borderRadius: "999px",
                border: "1px solid rgba(239,68,68,0.3)",
                background: "rgba(239, 68, 68, 0.15)",
                color: "#fca5a5",
                textDecoration: "none",
                fontWeight: 600,
              }}
            >
              Complaints
            </a>
          </div>
        </header>

        {error && (
          <div
            style={{
              marginTop: "1.5rem",
              padding: "0.9rem 1.2rem",
              borderRadius: "12px",
              background: "rgba(248, 113, 113, 0.12)",
              border: "1px solid rgba(248, 113, 113, 0.4)",
              color: "#fecaca",
            }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ marginTop: "2rem", opacity: 0.8 }}>Loading admin console...</div>
        ) : (
          <div style={{ display: "grid", gap: "2rem", marginTop: "2.5rem" }}>
            <section
              style={{
                padding: "1.8rem",
                borderRadius: "18px",
                background: "rgba(15, 23, 42, 0.85)",
                border: "1px solid rgba(148, 163, 184, 0.15)",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "1.5rem" }}>Create Trainer</h2>
              <p style={{ margin: "0.5rem 0 1.2rem", opacity: 0.7 }}>
                Invite a trainer account and automatically create an organization.
              </p>
              <div style={{ display: "grid", gap: "0.8rem", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                <input
                  type="email"
                  placeholder="trainer@company.com"
                  value={createEmail}
                  onChange={(event) => setCreateEmail(event.target.value)}
                  style={inputStyle}
                />
                <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
                  <input
                    type={showCreatePassword ? "text" : "password"}
                    placeholder="Temporary password (optional)"
                    value={createPassword}
                    onChange={(event) => setCreatePassword(event.target.value)}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowCreatePassword((prev) => !prev)}
                    style={{
                      padding: "0.6rem 0.75rem",
                      borderRadius: "10px",
                      border: "1px solid rgba(148, 163, 184, 0.3)",
                      background: "rgba(15, 23, 42, 0.6)",
                      color: "#e2e8f0",
                      cursor: "pointer",
                    }}
                  >
                    {showCreatePassword ? "Hide" : "Show"}
                  </button>
                </div>
                <select
                  value={createOrgId}
                  onChange={(event) => setCreateOrgId(event.target.value)}
                  style={inputStyle}
                >
                  <option value="">Create new organization</option>
                  {sortedOrgs.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Organization name (optional)"
                  value={createOrgName}
                  onChange={(event) => setCreateOrgName(event.target.value)}
                  style={inputStyle}
                />
                <button
                  onClick={handleCreateTrainer}
                  disabled={busy === "create-trainer" || !createEmail}
                  style={primaryButtonStyle(busy === "create-trainer" || !createEmail)}
                >
                  {busy === "create-trainer" ? "Creating..." : "Create Trainer"}
                </button>
              </div>
            </section>

            <section
              style={{
                padding: "1.8rem",
                borderRadius: "18px",
                background: "rgba(15, 23, 42, 0.85)",
                border: "1px solid rgba(148, 163, 184, 0.15)",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "1.5rem" }}>Organizations</h2>
              <p style={{ margin: "0.5rem 0 1.2rem", opacity: 0.7 }}>
                Add or rename organizations, or remove them completely.
              </p>
              <div style={{ display: "grid", gap: "0.8rem", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginBottom: "1.2rem" }}>
                <input
                  type="text"
                  placeholder="New organization name"
                  value={createOrgOnly}
                  onChange={(event) => setCreateOrgOnly(event.target.value)}
                  style={inputStyle}
                />
                <button
                  onClick={handleCreateOrg}
                  disabled={busy === "create-org" || !createOrgOnly}
                  style={primaryButtonStyle(busy === "create-org" || !createOrgOnly)}
                >
                  {busy === "create-org" ? "Creating..." : "Create Organization"}
                </button>
              </div>
              <div style={{ display: "grid", gap: "1rem" }}>
                {sortedOrgs.map((org) => (
                  <div
                    key={org.id}
                    style={{
                      padding: "1rem",
                      borderRadius: "14px",
                      background: "rgba(2, 6, 23, 0.5)",
                      border: "1px solid rgba(148, 163, 184, 0.12)",
                      display: "grid",
                      gap: "0.75rem",
                      gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: "0.85rem", opacity: 0.6 }}>Organization</div>
                      <div style={{ fontSize: "1.1rem" }}>{org.name}</div>
                    </div>
                    <input
                      type="text"
                      placeholder="Rename organization"
                      value={orgEdits[org.id]?.name || ""}
                      onChange={(event) => updateOrgEdit(org.id, event.target.value)}
                      style={inputStyle}
                    />
                    <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
                      <button
                        onClick={() => handleRenameOrg(org.id)}
                        disabled={busy === `rename-org-${org.id}` || !orgEdits[org.id]?.name}
                        style={secondaryButtonStyle(busy === `rename-org-${org.id}` || !orgEdits[org.id]?.name)}
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => handleDeleteOrg(org.id)}
                        disabled={busy === `delete-org-${org.id}`}
                        style={dangerButtonStyle(busy === `delete-org-${org.id}`)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
                {sortedOrgs.length === 0 && <div style={{ opacity: 0.7 }}>No organizations yet.</div>}
              </div>
            </section>

            <section
              style={{
                padding: "1.8rem",
                borderRadius: "18px",
                background: "rgba(15, 23, 42, 0.85)",
                border: "1px solid rgba(148, 163, 184, 0.15)",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "1.5rem" }}>Trainer Management</h2>
              <p style={{ margin: "0.5rem 0 1.2rem", opacity: 0.7 }}>
                Update trainer accounts, move them to another org, or disable access.
              </p>
              <div style={{ display: "grid", gap: "1.2rem" }}>
                {trainers.map((trainer) => (
                  <div
                    key={trainer.user_id}
                    style={{
                      padding: "1rem",
                      borderRadius: "14px",
                      background: "rgba(2, 6, 23, 0.5)",
                      border: "1px solid rgba(148, 163, 184, 0.12)",
                      display: "grid",
                      gap: "0.75rem",
                      gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: "0.85rem", opacity: 0.6 }}>Trainer</div>
                      <div style={{ fontSize: "1rem" }}>{trainer.email}</div>
                      <div style={{ fontSize: "0.8rem", opacity: 0.5 }}>{trainer.organization_name}</div>
                    </div>
                    <input
                      type="email"
                      placeholder="Update email"
                      value={trainerEdits[trainer.user_id]?.email || ""}
                      onChange={(event) => updateTrainerEdit(trainer.user_id, "email", event.target.value)}
                      style={inputStyle}
                    />
                    <input
                      type="password"
                      placeholder="Reset password"
                      value={trainerEdits[trainer.user_id]?.password || ""}
                      onChange={(event) => updateTrainerEdit(trainer.user_id, "password", event.target.value)}
                      style={inputStyle}
                    />
                    <select
                      value={trainerEdits[trainer.user_id]?.orgId || trainer.organization_id}
                      onChange={(event) => updateTrainerEdit(trainer.user_id, "orgId", event.target.value)}
                      style={inputStyle}
                    >
                      {sortedOrgs.map((org) => (
                        <option key={org.id} value={org.id}>
                          {org.name}
                        </option>
                      ))}
                    </select>
                    <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
                      <button
                        onClick={() => handleUpdateUser(trainer.user_id)}
                        disabled={busy === `update-user-${trainer.user_id}`}
                        style={secondaryButtonStyle(busy === `update-user-${trainer.user_id}`)}
                      >
                        Update Account
                      </button>
                      <button
                        onClick={() => handleMoveTrainer(trainer.user_id)}
                        disabled={busy === `move-trainer-${trainer.user_id}`}
                        style={secondaryButtonStyle(busy === `move-trainer-${trainer.user_id}`)}
                      >
                        Move Org
                      </button>
                      <button
                        onClick={() => handleDisableUser(trainer.user_id, false)}
                        disabled={busy === `disable-${trainer.user_id}`}
                        style={dangerButtonStyle(busy === `disable-${trainer.user_id}`)}
                      >
                        Disable
                      </button>
                      <button
                        onClick={() => handleDisableUser(trainer.user_id, true)}
                        disabled={busy === `enable-${trainer.user_id}`}
                        style={ghostButtonStyle(busy === `enable-${trainer.user_id}`)}
                      >
                        Enable
                      </button>
                      <button
                        onClick={() => handleRemoveTrainer(trainer.user_id)}
                        disabled={busy === `remove-trainer-${trainer.user_id}`}
                        style={dangerButtonStyle(busy === `remove-trainer-${trainer.user_id}`)}
                      >
                        Remove Trainer
                      </button>
                    </div>
                  </div>
                ))}
                {trainers.length === 0 && <div style={{ opacity: 0.7 }}>No trainers yet.</div>}
              </div>
            </section>
          </div>
        )}
      </section>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "0.65rem 0.75rem",
  borderRadius: "10px",
  border: "1px solid rgba(148, 163, 184, 0.3)",
  background: "rgba(15, 23, 42, 0.6)",
  color: "#e2e8f0",
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "0.75rem 1.1rem",
    borderRadius: "12px",
    border: "none",
    background: disabled ? "#334155" : "#22c55e",
    color: "#f8fafc",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function secondaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "0.65rem 1rem",
    borderRadius: "10px",
    border: "1px solid rgba(148, 163, 184, 0.3)",
    background: disabled ? "rgba(51, 65, 85, 0.7)" : "rgba(30, 41, 59, 0.85)",
    color: "#e2e8f0",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function dangerButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "0.65rem 1rem",
    borderRadius: "10px",
    border: "1px solid rgba(248, 113, 113, 0.5)",
    background: disabled ? "rgba(71, 85, 105, 0.8)" : "rgba(127, 29, 29, 0.8)",
    color: "#fecaca",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function ghostButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "0.65rem 1rem",
    borderRadius: "10px",
    border: "1px solid rgba(56, 189, 248, 0.4)",
    background: disabled ? "rgba(51, 65, 85, 0.7)" : "rgba(12, 74, 110, 0.7)",
    color: "#bae6fd",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
