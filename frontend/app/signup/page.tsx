"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  async function handleSignup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    router.push("/");
  }

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
      <form
        onSubmit={handleSignup}
        style={{
          width: "100%",
          maxWidth: "420px",
          padding: "2.5rem",
          borderRadius: "18px",
          background: "rgba(15, 23, 42, 0.85)",
          border: "1px solid rgba(148, 163, 184, 0.2)",
          display: "grid",
          gap: "1rem",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "2rem" }}>Create Account</h1>
        <p style={{ margin: 0, opacity: 0.75 }}>Start tracking your sales coaching sessions.</p>
        <label style={{ display: "grid", gap: "0.4rem" }}>
          <span style={{ fontSize: "0.85rem", opacity: 0.8 }}>Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            style={{
              padding: "0.65rem 0.75rem",
              borderRadius: "10px",
              border: "1px solid rgba(148, 163, 184, 0.3)",
              background: "rgba(15, 23, 42, 0.6)",
              color: "#e2e8f0",
            }}
          />
        </label>
        <label style={{ display: "grid", gap: "0.4rem" }}>
          <span style={{ fontSize: "0.85rem", opacity: 0.8 }}>Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            style={{
              padding: "0.65rem 0.75rem",
              borderRadius: "10px",
              border: "1px solid rgba(148, 163, 184, 0.3)",
              background: "rgba(15, 23, 42, 0.6)",
              color: "#e2e8f0",
            }}
          />
        </label>
        {error && <p style={{ margin: 0, color: "#fca5a5" }}>{error}</p>}
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "0.75rem",
            borderRadius: "12px",
            border: "none",
            background: loading ? "#475569" : "#22c55e",
            color: "#f8fafc",
            fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Creating..." : "Sign Up"}
        </button>
        <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.8 }}>
          Already have an account? <Link href="/login">Log in</Link>
        </p>
        <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.7 }}>
          New accounts start as trainees. Your admin will assign you to a trainer.
        </p>
      </form>
    </main>
  );
}
