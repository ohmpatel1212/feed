"use client";

import { useState } from "react";

interface PublishFeedModalProps {
  onClose: () => void;
  blueskyHandle: string;
  feedName: string;
  feedDescription: string;
  feedId?: number;
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
  backdropFilter: "blur(8px)", display: "flex", alignItems: "center",
  justifyContent: "center", zIndex: 100,
};
const modal: React.CSSProperties = {
  background: "var(--midnight, #0a1a14)", border: "1px solid var(--hair, #1a2e24)",
  borderRadius: 12, width: "100%", maxWidth: 460, overflow: "hidden",
  fontFamily: "var(--rf-body, system-ui)", color: "var(--cream, #f3ecdd)",
};
const headerStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "16px 24px", borderBottom: "1px solid var(--hair, #1a2e24)",
};
const bodyStyle: React.CSSProperties = { padding: "20px 24px" };
const inputStyle: React.CSSProperties = {
  width: "100%", background: "var(--void, #060f0b)",
  border: "1px solid var(--hair-strong, #2a3e34)", borderRadius: 8,
  padding: "10px 14px", fontSize: 13, color: "var(--cream)",
  fontFamily: "var(--rf-body)", outline: "none",
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, color: "var(--parchment-dim, #8a9a90)",
  fontFamily: "var(--rf-mono, monospace)", textTransform: "uppercase" as const,
  letterSpacing: "0.1em", marginBottom: 6, display: "block",
};

export default function PublishFeedModal({
  onClose,
  blueskyHandle,
  feedName,
  feedDescription,
  feedId,
}: PublishFeedModalProps) {
  const [appPassword, setAppPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<string | null>(null);

  async function handlePublish() {
    if (!appPassword.trim()) {
      setError("App password is required");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/publish-feed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: blueskyHandle,
          appPassword: appPassword.trim(),
          feedName,
          feedDescription,
          feedId,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setSuccess(data.message);
      }
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <span style={{ fontFamily: "var(--rf-display, Georgia)", fontSize: 15, fontWeight: 400 }}>
            Publish to Bluesky
          </span>
          <button
            style={{ background: "none", border: "none", color: "var(--parchment-dim)", fontSize: 20, cursor: "pointer" }}
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div style={bodyStyle}>
          {success ? (
            <div>
              <div style={{
                width: 40, height: 40, borderRadius: "50%",
                background: "var(--aurora, #7dcba5)", color: "var(--void)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 20, margin: "0 auto 16px",
              }}>
                ✓
              </div>
              <p style={{ fontSize: 14, textAlign: "center", marginBottom: 16, lineHeight: 1.6 }}>
                {success}
              </p>
              <p style={{ fontSize: 12, color: "var(--parchment-dim)", textAlign: "center", marginBottom: 20 }}>
                Open the Bluesky app and search for your feed name, or check your profile under Feeds.
              </p>
              <button
                onClick={onClose}
                style={{
                  width: "100%", padding: "10px", borderRadius: 8,
                  border: "none", cursor: "pointer", fontSize: 13,
                  background: "var(--hair-strong, #2a3e34)", color: "var(--cream)",
                  fontFamily: "var(--rf-body)",
                }}
              >
                Done
              </button>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 13, color: "var(--parchment-dim)", marginBottom: 16, lineHeight: 1.5 }}>
                To publish this feed to your Bluesky account, we need a one-time app password.
                Your password is only used for this request and is never stored.
              </p>

              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Bluesky handle</label>
                <div style={{
                  ...inputStyle, background: "transparent",
                  color: "var(--parchment-dim)", cursor: "default",
                }}>
                  @{blueskyHandle}
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>App password</label>
                <input
                  type="password"
                  value={appPassword}
                  onChange={(e) => { setAppPassword(e.target.value); setError(""); }}
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  style={inputStyle}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") handlePublish(); }}
                />
              </div>

              <div style={{
                fontSize: 11, color: "var(--parchment-dim)", marginBottom: 20,
                padding: "10px 12px", background: "rgba(125,203,165,0.06)",
                borderRadius: 6, lineHeight: 1.5,
              }}>
                <strong style={{ color: "var(--aurora)" }}>How to get an app password:</strong><br />
                Bluesky app &rarr; Settings &rarr; Privacy and Security &rarr; App Passwords &rarr; Add App Password
              </div>

              {error && (
                <p style={{ fontSize: 12, color: "var(--rose, #e09575)", marginBottom: 12 }}>{error}</p>
              )}

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={onClose}
                  style={{
                    flex: 1, padding: "10px", borderRadius: 8,
                    border: "1px solid var(--hair-strong, #2a3e34)",
                    background: "transparent", color: "var(--parchment-dim)",
                    cursor: "pointer", fontSize: 13, fontFamily: "var(--rf-body)",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handlePublish}
                  disabled={loading || !appPassword.trim()}
                  style={{
                    flex: 1, padding: "10px", borderRadius: 8,
                    border: "none", cursor: "pointer", fontSize: 13,
                    fontFamily: "var(--rf-body)", fontWeight: 500,
                    background: "var(--aurora, #7dcba5)", color: "var(--void, #060f0b)",
                    opacity: loading || !appPassword.trim() ? 0.4 : 1,
                  }}
                >
                  {loading ? "Publishing..." : "Publish feed"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
