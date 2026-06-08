"use client";

import { useEffect, useState } from "react";
import { authedFetch } from "@/lib/authed-fetch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";

interface PublishFeedModalProps {
  onClose: () => void;
  blueskyHandle: string;
  blueskyDid: string;
  feedName: string;
  feedId: number;
  onConnectBluesky: () => void;
}

type AuthPhase = "checking" | "local_dev" | "unlinked" | "needs_oauth" | "ready";

export default function PublishFeedModal({
  onClose,
  blueskyHandle,
  blueskyDid,
  feedName,
  feedId,
  onConnectBluesky,
}: PublishFeedModalProps) {
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [appPassword, setAppPassword] = useState("");
  const [showAppPassword, setShowAppPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<string | null>(null);
  const [prodPublishUrl, setProdPublishUrl] = useState("https://willownet.co");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [feedgenRes, statusRes] = await Promise.all([
          fetch("/api/feedgen/info"),
          authedFetch("/api/bsky/status", { suppressErrorToast: true }),
        ]);
        if (cancelled) return;

        if (feedgenRes.ok) {
          const feedgen = await feedgenRes.json();
          if (feedgen.publishUrl) setProdPublishUrl(feedgen.publishUrl);
          if (!feedgen.publishable) {
            setAuthPhase("local_dev");
            return;
          }
        }

        if (!statusRes.ok) {
          setAuthPhase(blueskyHandle || blueskyDid ? "needs_oauth" : "unlinked");
          return;
        }
        const data = await statusRes.json();
        if (!data.linked) {
          setAuthPhase("unlinked");
        } else if (data.oauthReady) {
          setAuthPhase("ready");
        } else {
          setAuthPhase("needs_oauth");
        }
      } catch {
        if (!cancelled) {
          setAuthPhase(blueskyHandle || blueskyDid ? "needs_oauth" : "unlinked");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blueskyHandle, blueskyDid]);

  async function handleAuthorize() {
    const handle = blueskyHandle.replace(/^@/, "").trim();
    if (!handle) {
      onConnectBluesky();
      return;
    }
    setAuthorizing(true);
    setError("");
    try {
      const res = await authedFetch("/api/bsky/oauth/authorize", {
        method: "POST",
        body: JSON.stringify({ handle }),
        suppressErrorToast: true,
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.error || "Could not start Bluesky authorization.");
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Could not start Bluesky authorization.");
    } finally {
      setAuthorizing(false);
    }
  }

  async function handlePublish() {
    setLoading(true);
    setError("");

    try {
      const res = await authedFetch("/api/publish-feed", {
        method: "POST",
        body: JSON.stringify({
          feedId,
          appPassword: appPassword.trim() || undefined,
        }),
        suppressErrorToast: true,
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        const msg = data.error || `HTTP ${res.status}`;
        if (data.code === "reauth_required") {
          setAuthPhase("needs_oauth");
          setShowAppPassword(true);
        } else if (data.code === "local_feedgen") {
          setAuthPhase("local_dev");
        }
        setError(msg);
        return;
      }
      setSuccess(data.message);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  const fieldStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--void)",
    border: "1px solid var(--hair-strong)",
    borderRadius: 8,
    padding: "10px 14px",
    fontSize: 13,
    color: "var(--cream)",
    fontFamily: "var(--rf-body)",
    outline: "none",
  };

  const handleDisplay = blueskyHandle.replace(/^@/, "");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="profile-dialog" style={{ maxWidth: 460 }}>
        <DialogHeader>
          <DialogTitle
            style={{
              fontFamily: "var(--rf-display)",
              fontSize: 22,
              fontWeight: 400,
              color: "var(--cream)",
            }}
          >
            Publish to Bluesky
          </DialogTitle>
        </DialogHeader>

        {success ? (
          <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                background: "var(--aurora)",
                color: "var(--void)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 20,
                margin: "0 auto 16px",
              }}
            >
              ✓
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 12 }}>
              {success}
            </p>
            <p
              style={{
                fontSize: 12,
                color: "var(--parchment-dim)",
                marginBottom: 20,
              }}
            >
              Open the Bluesky app, search for &ldquo;{feedName}&rdquo;, or check
              your profile under Feeds.
            </p>
            <button
              type="button"
              onClick={onClose}
              style={{
                width: "100%",
                padding: "10px",
                borderRadius: 8,
                border: "none",
                cursor: "pointer",
                fontSize: 13,
                background: "var(--hair-strong)",
                color: "var(--cream)",
                fontFamily: "var(--rf-body)",
              }}
            >
              Done
            </button>
          </div>
        ) : authPhase === "checking" ? (
          <p style={{ fontSize: 13, color: "var(--parchment-dim)", padding: "12px 0" }}>
            Checking Bluesky authorization…
          </p>
        ) : authPhase === "local_dev" ? (
          <div>
            <p
              style={{
                fontSize: 13,
                color: "var(--parchment-dim)",
                lineHeight: 1.5,
                marginBottom: 16,
              }}
            >
              This feed was registered pointing at{" "}
              <code style={{ color: "var(--cream)" }}>did:web:localhost</code>{" "}
              because you published from local dev. Bluesky cannot reach localhost,
              so the feed breaks in the app.
            </p>
            <p
              style={{
                fontSize: 13,
                color: "var(--parchment-dim)",
                lineHeight: 1.5,
                marginBottom: 20,
              }}
            >
              Open{" "}
              <a
                href={prodPublishUrl}
                style={{ color: "var(--aurora)" }}
                target="_blank"
                rel="noopener noreferrer"
              >
                {prodPublishUrl.replace(/^https?:\/\//, "")}
              </a>
              , authorize Bluesky, and publish again — that updates the feed to{" "}
              <code style={{ color: "var(--cream)" }}>did:web:willownet.co</code>.
            </p>
            <button
              type="button"
              onClick={onClose}
              style={{
                width: "100%",
                padding: "10px",
                borderRadius: 8,
                border: "1px solid var(--hair-strong)",
                background: "transparent",
                color: "var(--parchment-dim)",
                cursor: "pointer",
                fontSize: 13,
                fontFamily: "var(--rf-body)",
              }}
            >
              Got it
            </button>
          </div>
        ) : authPhase === "unlinked" ? (
          <div>
            <p
              style={{
                fontSize: 13,
                color: "var(--parchment-dim)",
                lineHeight: 1.5,
                marginBottom: 20,
              }}
            >
              Link your Bluesky account before publishing. We use OAuth — no
              password is stored.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: 8,
                  border: "1px solid var(--hair-strong)",
                  background: "transparent",
                  color: "var(--parchment-dim)",
                  cursor: "pointer",
                  fontSize: 13,
                  fontFamily: "var(--rf-body)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConnectBluesky}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: 8,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontFamily: "var(--rf-body)",
                  fontWeight: 500,
                  background: "var(--aurora)",
                  color: "var(--void)",
                }}
              >
                Connect Bluesky
              </button>
            </div>
          </div>
        ) : authPhase === "needs_oauth" ? (
          <div>
            <p
              style={{
                fontSize: 13,
                color: "var(--parchment-dim)",
                lineHeight: 1.5,
                marginBottom: 16,
              }}
            >
              Your handle is linked, but publishing requires a one-time Bluesky
              authorization so we can register the feed on your account.
            </p>

            {handleDisplay && (
              <div
                style={{
                  ...fieldStyle,
                  background: "transparent",
                  color: "var(--parchment-dim)",
                  marginBottom: 16,
                }}
              >
                @{handleDisplay}
              </div>
            )}

            <button
              type="button"
              onClick={handleAuthorize}
              disabled={authorizing}
              style={{
                width: "100%",
                padding: "10px",
                borderRadius: 8,
                border: "none",
                cursor: authorizing ? "not-allowed" : "pointer",
                fontSize: 13,
                fontFamily: "var(--rf-body)",
                fontWeight: 500,
                background: "var(--aurora)",
                color: "var(--void)",
                opacity: authorizing ? 0.6 : 1,
                marginBottom: 12,
              }}
            >
              {authorizing ? "Redirecting…" : "Authorize Bluesky"}
            </button>

            <button
              type="button"
              onClick={() => setShowAppPassword((v) => !v)}
              style={{
                background: "none",
                border: "none",
                color: "var(--parchment-dim)",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "var(--rf-body)",
                textDecoration: "underline",
                padding: 0,
                marginBottom: showAppPassword ? 12 : 0,
              }}
            >
              {showAppPassword ? "Hide app password option" : "Use an app password instead"}
            </button>

            {showAppPassword && (
              <>
                <Separator style={{ margin: "12px 0" }} />
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--parchment-dim)",
                    marginBottom: 10,
                    lineHeight: 1.5,
                  }}
                >
                  Bluesky app → Settings → Privacy and Security → App Passwords
                </p>
                <input
                  type="password"
                  value={appPassword}
                  onChange={(e) => {
                    setAppPassword(e.target.value);
                    setError("");
                  }}
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  style={{ ...fieldStyle, marginBottom: 12 }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !loading && appPassword.trim()) {
                      handlePublish();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={handlePublish}
                  disabled={loading || !appPassword.trim()}
                  style={{
                    width: "100%",
                    padding: "10px",
                    borderRadius: 8,
                    border: "none",
                    cursor: "pointer",
                    fontSize: 13,
                    fontFamily: "var(--rf-body)",
                    fontWeight: 500,
                    background: "var(--hair-strong)",
                    color: "var(--cream)",
                    opacity: loading || !appPassword.trim() ? 0.4 : 1,
                  }}
                >
                  {loading ? "Publishing…" : "Publish with app password"}
                </button>
              </>
            )}

            {error && (
              <p style={{ fontSize: 12, color: "var(--rose)", marginTop: 12 }}>
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={onClose}
              style={{
                width: "100%",
                marginTop: 16,
                padding: "8px",
                borderRadius: 8,
                border: "1px solid var(--hair-strong)",
                background: "transparent",
                color: "var(--parchment-dim)",
                cursor: "pointer",
                fontSize: 13,
                fontFamily: "var(--rf-body)",
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div>
            <p
              style={{
                fontSize: 13,
                color: "var(--parchment-dim)",
                lineHeight: 1.5,
                marginBottom: 16,
              }}
            >
              Register &ldquo;{feedName}&rdquo; as a custom feed on your Bluesky
              account. Bluesky will fetch posts from Willow whenever someone opens
              the feed.
            </p>

            {handleDisplay && (
              <>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--parchment-dim)",
                    fontFamily: "var(--rf-mono)",
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    marginBottom: 6,
                  }}
                >
                  Publishing as
                </div>
                <div
                  style={{
                    ...fieldStyle,
                    background: "transparent",
                    color: "var(--parchment-dim)",
                    marginBottom: 16,
                  }}
                >
                  @{handleDisplay}
                </div>
              </>
            )}

            {error && (
              <p
                style={{
                  fontSize: 12,
                  color: "var(--rose)",
                  marginBottom: 12,
                }}
              >
                {error}
              </p>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: 8,
                  border: "1px solid var(--hair-strong)",
                  background: "transparent",
                  color: "var(--parchment-dim)",
                  cursor: "pointer",
                  fontSize: 13,
                  fontFamily: "var(--rf-body)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handlePublish}
                disabled={loading}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: 8,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontFamily: "var(--rf-body)",
                  fontWeight: 500,
                  background: "var(--aurora)",
                  color: "var(--void)",
                  opacity: loading ? 0.4 : 1,
                }}
              >
                {loading ? "Publishing…" : "Publish feed"}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
