"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001";

type Contact = {
  user_id: string;
  email: string;
  role: string;
  organization_id: string;
  organizationName: string;
};

type Conversation = {
  id: string;
  participant_1: string;
  participant_2: string;
  organization_id: string;
  otherUserId: string;
  otherEmail: string;
  myEmail: string;
  lastMessage: string | null;
  lastMessageAt: string;
  unreadCount: number;
  participant_1_email: string;
  participant_2_email: string;
};

type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  read: boolean;
  created_at: string;
  sender_email?: string;
  sender_role?: string;
};

export default function MessagesPage() {
  const router = useRouter();

  const [authToken, setAuthToken] = useState<string>("");
  const [userId, setUserId] = useState<string>("");
  const [userEmail, setUserEmail] = useState<string>("");
  const [loading, setLoading] = useState(true);

  // Role info
  const [isAdmin, setIsAdmin] = useState(false);
  const [role, setRole] = useState("");

  // Contacts & conversations
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);

  // Active chat
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageInput, setMessageInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // New conversation modal
  const [showNewChat, setShowNewChat] = useState(false);

  // Responsive sidebar
  const [showSidebar, setShowSidebar] = useState(true);

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
      setUserId(session.user.id);
      setUserEmail(session.user.email || "");
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setAuthToken("");
        router.push("/login");
        return;
      }
      setAuthToken(session.access_token);
      setUserId(session.user.id);
      setUserEmail(session.user.email || "");
    });

    return () => {
      active = false;
      authListener?.subscription.unsubscribe();
    };
  }, [router]);

  // Determine role
  useEffect(() => {
    if (!authToken) return;
    let active = true;

    async function checkRole() {
      try {
        const adminRes = await fetch(`${API_BASE}/api/admin/me`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (adminRes.ok) {
          const adminData = await adminRes.json();
          if (active && adminData.isAdmin) {
            setIsAdmin(true);
            setRole("admin");
            return;
          }
        }
        const orgRes = await fetch(`${API_BASE}/api/org/me`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (orgRes.ok) {
          const orgData = await orgRes.json();
          if (active) {
            setRole(orgData.role || "");
          }
        }
      } catch {
        // ignore
      }
    }

    checkRole();
    return () => {
      active = false;
    };
  }, [authToken]);

  // Load conversations + contacts
  const loadConversations = useCallback(async () => {
    if (!authToken) return;
    try {
      const res = await fetch(`${API_BASE}/api/conversations`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setConversations(data.conversations || []);
      }
    } catch {
      // ignore
    }
  }, [authToken]);

  const loadContacts = useCallback(async () => {
    if (!authToken) return;
    try {
      const res = await fetch(`${API_BASE}/api/messages/contacts`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setContacts(data.contacts || []);
      }
    } catch {
      // ignore
    }
  }, [authToken]);

  useEffect(() => {
    if (!authToken) return;
    setLoading(true);
    Promise.all([loadConversations(), loadContacts()]).finally(() => setLoading(false));
  }, [authToken, loadConversations, loadContacts]);

  // Load messages for active conversation
  const loadMessages = useCallback(async () => {
    if (!authToken || !activeConversation) return;
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${activeConversation.id}/messages`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
    } catch {
      // ignore
    }
  }, [authToken, activeConversation]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Mark messages as read when opening a conversation
  useEffect(() => {
    if (!authToken || !activeConversation) return;

    async function markRead() {
      try {
        await fetch(`${API_BASE}/api/conversations/${activeConversation!.id}/read-all`, {
          method: "POST",
          headers: { Authorization: `Bearer ${authToken}` },
        });
        // Refresh conversation list to update unread counts
        loadConversations();
      } catch {
        // ignore
      }
    }

    markRead();
  }, [authToken, activeConversation, loadConversations]);

  // Realtime subscription for new messages
  useEffect(() => {
    if (!activeConversation) return;

    const channel = supabase
      .channel(`messages:${activeConversation.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${activeConversation.id}`,
        },
        (payload) => {
          const newMsg = payload.new as Message;
          setMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
          });
          // Mark as read if the msg is from the other person
          if (newMsg.sender_id !== userId) {
            fetch(`${API_BASE}/api/messages/${newMsg.id}/read`, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${authToken}` },
            }).catch(() => {});
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeConversation, userId, authToken]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Poll conversations every 10s to update unread counts
  useEffect(() => {
    if (!authToken) return;
    const interval = setInterval(loadConversations, 10000);
    return () => clearInterval(interval);
  }, [authToken, loadConversations]);

  async function sendMessage() {
    if (!messageInput.trim() || !activeConversation || sending) return;
    setSending(true);
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${activeConversation.id}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: messageInput.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setMessages((prev) => {
          if (prev.some((m) => m.id === data.message.id)) return prev;
          return [...prev, data.message];
        });
        setMessageInput("");
        loadConversations(); // refresh last message
      }
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  }

  async function startConversation(contactUserId: string) {
    try {
      const res = await fetch(`${API_BASE}/api/conversations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ otherUserId: contactUserId }),
      });
      if (res.ok) {
        const data = await res.json();
        await loadConversations();
        // Find the conversation and activate it
        const conv = data.conversation;
        const emailMap = contacts.reduce((acc, c) => ({ ...acc, [c.user_id]: c.email }), {} as Record<string, string>);
        const otherId = conv.participant_1 === userId ? conv.participant_2 : conv.participant_1;
        setActiveConversation({
          ...conv,
          otherUserId: otherId,
          otherEmail: emailMap[otherId] || otherId,
          myEmail: userEmail,
          lastMessage: null,
          lastMessageAt: conv.updated_at,
          unreadCount: 0,
          participant_1_email: emailMap[conv.participant_1] || conv.participant_1,
          participant_2_email: emailMap[conv.participant_2] || conv.participant_2,
        });
        setShowNewChat(false);
        setShowSidebar(false);
      }
    } catch {
      // ignore
    }
  }

  function openConversation(conv: Conversation) {
    setActiveConversation(conv);
    setShowSidebar(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  // Figure out back link based on role
  const backLink = isAdmin ? "/admin" : role === "trainer" ? "/analytics" : "/";
  const backLabel = isAdmin ? "Back to Admin" : role === "trainer" ? "Back to Dashboard" : "Back to Home";

  // Filter contacts that don't already have a conversation
  const existingOtherIds = new Set(conversations.map((c) => c.otherUserId));
  const newContacts = contacts.filter((c) => !existingOtherIds.has(c.user_id));

  if (loading) {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #0b1220, #12203a)",
          color: "#e2e8f0",
          fontFamily: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
        }}
      >
        <p>Loading messages...</p>
      </main>
    );
  }

  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "linear-gradient(135deg, #0b1220, #12203a)",
        color: "#e2e8f0",
        fontFamily: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Top bar */}
      <header
        style={{
          padding: "0.75rem 1.5rem",
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          borderBottom: "1px solid rgba(148,163,184,0.15)",
          background: "rgba(15, 23, 42, 0.95)",
          flexShrink: 0,
        }}
      >
        <Link
          href={backLink}
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
          {backLabel}
        </Link>
        <h1 style={{ margin: 0, fontSize: "1.3rem", fontWeight: 700, flex: 1 }}>Messages</h1>
        <span style={{ fontSize: "0.8rem", opacity: 0.7 }}>{userEmail}</span>
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

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Sidebar — conversation list */}
        <aside
          style={{
            width: "320px",
            minWidth: "280px",
            borderRight: "1px solid rgba(148,163,184,0.15)",
            display: "flex",
            flexDirection: "column",
            background: "rgba(15, 23, 42, 0.6)",
            ...(showSidebar ? {} : { display: activeConversation ? "none" : "flex" }),
          }}
        >
          <div
            style={{
              padding: "0.75rem 1rem",
              borderBottom: "1px solid rgba(148,163,184,0.1)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>Chats</span>
            {newContacts.length > 0 && (
              <button
                onClick={() => setShowNewChat(!showNewChat)}
                style={{
                  padding: "0.35rem 0.7rem",
                  borderRadius: "8px",
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "rgba(14,165,233,0.25)",
                  color: "#e2e8f0",
                  cursor: "pointer",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                }}
              >
                + New
              </button>
            )}
          </div>

          {/* New chat contact selector */}
          {showNewChat && (
            <div
              style={{
                padding: "0.5rem 0.75rem",
                borderBottom: "1px solid rgba(148,163,184,0.1)",
                maxHeight: "200px",
                overflowY: "auto",
              }}
            >
              <p style={{ fontSize: "0.78rem", opacity: 0.65, margin: "0 0 0.4rem" }}>Select a contact:</p>
              {newContacts.map((c) => (
                <button
                  key={c.user_id}
                  onClick={() => startConversation(c.user_id)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "0.5rem 0.6rem",
                    marginBottom: "0.3rem",
                    borderRadius: "8px",
                    border: "1px solid rgba(148,163,184,0.12)",
                    background: "rgba(2,6,23,0.5)",
                    color: "#e2e8f0",
                    cursor: "pointer",
                    fontSize: "0.82rem",
                  }}
                >
                  <strong>{c.email}</strong>
                  <span style={{ opacity: 0.6, marginLeft: "0.5rem" }}>
                    ({c.role}{c.organizationName ? ` · ${c.organizationName}` : ""})
                  </span>
                </button>
              ))}
              {newContacts.length === 0 && (
                <p style={{ fontSize: "0.8rem", opacity: 0.5 }}>No more contacts available.</p>
              )}
            </div>
          )}

          {/* Conversation list */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {conversations.length === 0 && (
              <p style={{ padding: "1rem", textAlign: "center", opacity: 0.5, fontSize: "0.85rem" }}>
                No conversations yet.
              </p>
            )}
            {conversations.map((conv) => {
              const isActive = activeConversation?.id === conv.id;
              const displayName = isAdmin
                ? `${conv.participant_1_email} ↔ ${conv.participant_2_email}`
                : conv.otherEmail;

              return (
                <button
                  key={conv.id}
                  onClick={() => openConversation(conv)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "0.75rem 1rem",
                    borderBottom: "1px solid rgba(148,163,184,0.08)",
                    background: isActive ? "rgba(14,165,233,0.15)" : "transparent",
                    color: "#e2e8f0",
                    cursor: "pointer",
                    border: "none",
                    borderLeft: isActive ? "3px solid #0ea5e9" : "3px solid transparent",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span
                      style={{
                        fontWeight: conv.unreadCount > 0 ? 700 : 500,
                        fontSize: "0.88rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: isAdmin ? "240px" : "200px",
                      }}
                    >
                      {displayName}
                    </span>
                    {conv.unreadCount > 0 && (
                      <span
                        style={{
                          background: "#0ea5e9",
                          color: "white",
                          borderRadius: "999px",
                          padding: "0.15rem 0.5rem",
                          fontSize: "0.7rem",
                          fontWeight: 700,
                          flexShrink: 0,
                        }}
                      >
                        {conv.unreadCount}
                      </span>
                    )}
                  </div>
                  {conv.lastMessage && (
                    <p
                      style={{
                        margin: "0.25rem 0 0",
                        fontSize: "0.78rem",
                        opacity: 0.55,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {conv.lastMessage}
                    </p>
                  )}
                  <p style={{ margin: "0.15rem 0 0", fontSize: "0.7rem", opacity: 0.4 }}>
                    {new Date(conv.lastMessageAt).toLocaleString()}
                  </p>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Chat panel */}
        <section
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            ...(activeConversation ? {} : { display: showSidebar ? "flex" : "flex" }),
          }}
        >
          {!activeConversation ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: 0.4,
              }}
            >
              <div style={{ textAlign: "center" }}>
                <p style={{ fontSize: "2rem", margin: 0 }}>💬</p>
                <p style={{ fontSize: "1rem" }}>Select a conversation or start a new chat</p>
              </div>
            </div>
          ) : (
            <>
              {/* Chat header */}
              <div
                style={{
                  padding: "0.65rem 1rem",
                  borderBottom: "1px solid rgba(148,163,184,0.15)",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  background: "rgba(15, 23, 42, 0.8)",
                  flexShrink: 0,
                }}
              >
                <button
                  onClick={() => {
                    setActiveConversation(null);
                    setShowSidebar(true);
                  }}
                  style={{
                    padding: "0.3rem 0.6rem",
                    borderRadius: "8px",
                    border: "1px solid rgba(255,255,255,0.15)",
                    background: "rgba(148,163,184,0.15)",
                    color: "#e2e8f0",
                    cursor: "pointer",
                    fontSize: "0.8rem",
                  }}
                >
                  ←
                </button>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                    {isAdmin
                      ? `${activeConversation.participant_1_email} ↔ ${activeConversation.participant_2_email}`
                      : activeConversation.otherEmail}
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "1rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                }}
              >
                {messages.length === 0 && (
                  <p style={{ textAlign: "center", opacity: 0.4, margin: "auto" }}>
                    No messages yet. Say hello! 👋
                  </p>
                )}
                {messages.map((msg) => {
                  const isMine = msg.sender_id === userId;
                  return (
                    <div
                      key={msg.id}
                      style={{
                        display: "flex",
                        justifyContent: isMine ? "flex-end" : "flex-start",
                      }}
                    >
                      <div
                        style={{
                          maxWidth: "70%",
                          padding: "0.6rem 0.9rem",
                          borderRadius: isMine ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                          background: isMine
                            ? "rgba(14, 165, 233, 0.3)"
                            : "rgba(148, 163, 184, 0.15)",
                          border: `1px solid ${isMine ? "rgba(14,165,233,0.3)" : "rgba(148,163,184,0.12)"}`,
                        }}
                      >
                        {!isMine && msg.sender_role && (
                          <p
                            style={{
                              margin: "0 0 0.3rem",
                              fontSize: "0.7rem",
                              display: "flex",
                              alignItems: "center",
                              gap: "0.35rem",
                            }}
                          >
                            <span
                              style={{
                                padding: "0.1rem 0.4rem",
                                borderRadius: "4px",
                                fontWeight: 700,
                                fontSize: "0.65rem",
                                textTransform: "uppercase",
                                letterSpacing: "0.04em",
                                ...(msg.sender_role === "admin"
                                  ? { background: "rgba(239,68,68,0.25)", color: "#fca5a5" }
                                  : msg.sender_role === "trainer"
                                  ? { background: "rgba(14,165,233,0.25)", color: "#7dd3fc" }
                                  : { background: "rgba(34,197,94,0.2)", color: "#86efac" }),
                              }}
                            >
                              {msg.sender_role}
                            </span>
                            <span style={{ opacity: 0.5 }}>{msg.sender_email || ""}</span>
                          </p>
                        )}
                        <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
                          {msg.content}
                        </p>
                        <p
                          style={{
                            margin: "0.25rem 0 0",
                            fontSize: "0.65rem",
                            opacity: 0.4,
                            textAlign: isMine ? "right" : "left",
                          }}
                        >
                          {new Date(msg.created_at).toLocaleTimeString()}
                          {isMine && msg.read && " ✓✓"}
                        </p>
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              {/* Message input */}
              <div
                style={{
                  padding: "0.75rem 1rem",
                  borderTop: "1px solid rgba(148,163,184,0.15)",
                  display: "flex",
                  gap: "0.5rem",
                  background: "rgba(15, 23, 42, 0.8)",
                  flexShrink: 0,
                }}
              >
                <input
                  type="text"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder="Type a message..."
                  style={{
                    flex: 1,
                    padding: "0.6rem 0.9rem",
                    borderRadius: "12px",
                    border: "1px solid rgba(148,163,184,0.2)",
                    background: "rgba(2,6,23,0.6)",
                    color: "#e2e8f0",
                    fontSize: "0.9rem",
                    outline: "none",
                  }}
                />
                <button
                  onClick={sendMessage}
                  disabled={sending || !messageInput.trim()}
                  style={{
                    padding: "0.6rem 1.2rem",
                    borderRadius: "12px",
                    border: "none",
                    background: sending || !messageInput.trim() ? "#374151" : "#0ea5e9",
                    color: "white",
                    cursor: sending || !messageInput.trim() ? "not-allowed" : "pointer",
                    fontWeight: 600,
                    fontSize: "0.9rem",
                  }}
                >
                  {sending ? "..." : "Send"}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
