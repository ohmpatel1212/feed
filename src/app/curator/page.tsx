"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import "./curator.css";
import "./onboarding.css";
import "./voices.css";
import "./onboarding-flow.css";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import Onboarding, { useAuth, type UserProfile } from "@/components/Onboarding";
import { saveFeedToFirestore, loadFeedsFromFirestore, deleteFeedFromFirestore, saveChatMessagesToFirestore, loadChatMessagesFromFirestore } from "@/lib/firebase";
import VoiceCards, { type Voice } from "@/components/VoiceCards";
import ImportMemoryModal from "@/components/ImportMemoryModal";
import PublishFeedModal from "@/components/PublishFeedModal";
import FilterPanel from "@/components/FilterPanel";
import Logo from "@/components/Logo";
import ShaderLogo from "@/components/ShaderLogo";
import ShaderSendButton from "@/components/ShaderSendButton";
import OnboardingFlow from "@/components/OnboardingFlow";
import { authedFetch } from "@/lib/authed-fetch";
import type { MechanicalFilters, SemanticConfig } from "@/lib/types";

interface Message { role: "user" | "assistant"; content: string; }
interface FeedCriteria {
  topics: string[]; keywords: string[];
  exclude_topics: string[]; exclude_keywords: string[];
  vibes: string;
}
interface Preferences { description: string; criteria: FeedCriteria; }
interface Post {
  uri: string; author_did: string; text: string;
  score: number; indexed_at: string;
}

interface SavedFeed {
  id: string;
  name: string;
  color: string;
  criteria: FeedCriteria;
  createdAt: string;
}

const FEED_COLORS = ["var(--aurora)", "var(--amber)", "var(--ember)", "var(--rose)", "var(--aurora-deep)", "var(--mist)"];

function loadFeeds(): SavedFeed[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem("ripple_feeds") || "[]"); }
  catch { return []; }
}
function saveFeeds(feeds: SavedFeed[]) {
  localStorage.setItem("ripple_feeds", JSON.stringify(feeds));
}

function feedName(criteria: FeedCriteria): string {
  const parts = [...(criteria.topics || []), ...(criteria.keywords || []).slice(0, 2)];
  return parts.slice(0, 3).join(", ") || "My Feed";
}

function parseMessage(content: string) {
  const lines = content.split("\n");
  const options: { key: string; label: string }[] = [];
  const textLines: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d)\.\s+(.+)/);
    if (m) options.push({ key: m[1], label: m[2] });
    else textLines.push(line);
  }
  return { text: textLines.join("\n").trim(), options };
}


export default function CuratorPage() {
  const { profile, setProfile, isOnboarded, loading: authLoading } = useAuth();

  if (authLoading) {
    return (
      <div className="curator-shell" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="cur-dots"><span /><span /><span /></div>
      </div>
    );
  }

  if (!isOnboarded) {
    return <Onboarding onComplete={setProfile} />;
  }

  return <CuratorApp profile={profile!} />;
}

function CuratorApp({ profile }: { profile: UserProfile }) {
  const [view, setView] = useState<"chat" | "feed">("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [postCount, setPostCount] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const [feeds, setFeeds] = useState<SavedFeed[]>([]);
  const [activeFeedId, setActiveFeedId] = useState<string | null>(null);
  const [prevCriteriaJson, setPrevCriteriaJson] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [showVoices, setShowVoices] = useState(false);
  const [addedVoices, setAddedVoices] = useState<Voice[]>([]);
  const [showImportMemory, setShowImportMemory] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [onboardingActive, setOnboardingActive] = useState(false);
  const [mechanicalFilters, setMechanicalFilters] = useState<MechanicalFilters | null>(null);
  const [semanticConfig, setSemanticConfig] = useState<SemanticConfig | null>(null);
  const serverFeedIdRef = useRef<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Save mechanical filters to the server
  async function saveMechanicalFilters(filters: MechanicalFilters) {
    const feedId = serverFeedIdRef.current;
    if (!feedId) return;
    setMechanicalFilters(filters);
    try {
      await authedFetch("/api/feeds", {
        method: "PATCH",
        body: JSON.stringify({ id: feedId, mechanical_filters: filters }),
      });
    } catch {
      // ignore
    }
  }

  // Save semantic config to the server
  async function saveSemanticConfig(config: SemanticConfig) {
    const feedId = serverFeedIdRef.current;
    if (!feedId) return;
    setSemanticConfig(config);
    try {
      await authedFetch("/api/feeds", {
        method: "PATCH",
        body: JSON.stringify({ id: feedId, semantic_config: config }),
      });
    } catch {
      // ignore
    }
  }

  // Load saved feeds from localStorage + Firestore
  useEffect(() => {
    const local = loadFeeds();
    setFeeds(local);
    loadFeedsFromFirestore(profile.uid).then((fsFeeds) => {
      if (fsFeeds.length > 0) {
        const merged = [...fsFeeds];
        for (const lf of local) {
          if (!merged.find(f => f.id === lf.id)) merged.push(lf);
        }
        setFeeds(merged);
        saveFeeds(merged);
      }
    }).catch(() => {});
  }, [profile.uid]);

  // Create a server-side feed and init chat
  async function ensureServerFeed(): Promise<number> {
    if (serverFeedIdRef.current) return serverFeedIdRef.current;
    const res = await authedFetch("/api/feeds", {
      method: "POST",
      body: JSON.stringify({ name: "New Feed" }),
    });
    const data = await res.json();
    const id = data.feed?.id || data.id;
    serverFeedIdRef.current = id;
    return id;
  }

  // Init: create server feed and get opening message
  useEffect(() => {
    (async () => {
      try {
        const feedId = await ensureServerFeed();
        const chatRes = await authedFetch(`/api/chat?feedId=${feedId}`);
        const data = await chatRes.json();
        const msgs: Message[] = data.messages || [];
        if (data.feed?.criteria) {
          setPrefs({ description: data.feed.description, criteria: data.feed.criteria });
          setPrevCriteriaJson(JSON.stringify(data.feed.criteria));
        }
        if (msgs.length === 0) {
          setLoading(true);
          const initRes = await authedFetch("/api/chat", {
            method: "POST",
            body: JSON.stringify({ message: "__init__", feedId }),
          });
          const d = await initRes.json();
          setMessages(d.messages || []);
          if (d.feed?.criteria) {
            setPrefs({ description: d.feed.description, criteria: d.feed.criteria });
          }
          setLoading(false);
        } else {
          setMessages(msgs);
        }
      } catch { /* ignore */ }
      setInitialized(true);
    })();
  }, []);

  // Watch for new criteria — update the active feed entry
  const checkNewFeed = useCallback((newPrefs: Preferences) => {
    const newJson = JSON.stringify(newPrefs.criteria);
    const hasCriteria = (newPrefs.criteria.topics?.length ?? 0) > 0 ||
      (newPrefs.criteria.keywords?.length ?? 0) > 0;

    if (hasCriteria && newJson !== prevCriteriaJson) {
      setPrevCriteriaJson(newJson);
      const name = feedName(newPrefs.criteria);

      // If we have an active feed (e.g. "Untitled"), update it with the new criteria + name
      if (activeFeedId) {
        const updated = feeds.map(f =>
          f.id === activeFeedId ? { ...f, name, criteria: newPrefs.criteria } : f
        );
        setFeeds(updated);
        saveFeeds(updated);
        const updatedFeed = updated.find(f => f.id === activeFeedId);
        if (updatedFeed) saveFeedToFirestore(profile.uid, updatedFeed).catch(() => {});
      } else {
        // No active feed — create one
        const newFeed: SavedFeed = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          name,
          color: FEED_COLORS[feeds.length % FEED_COLORS.length],
          criteria: newPrefs.criteria,
          createdAt: new Date().toISOString(),
        };
        const updated = [...feeds, newFeed];
        setFeeds(updated);
        saveFeeds(updated);
        saveFeedToFirestore(profile.uid, newFeed).catch(() => {});
        setActiveFeedId(newFeed.id);
      }
      setShowVoices(true);
    }
  }, [feeds, prevCriteriaJson, activeFeedId]);

  // Poll feed posts
  useEffect(() => {
    const poll = () => {
      const fid = serverFeedIdRef.current;
      if (!fid) return;
      authedFetch(`/api/feed-preview?feedId=${fid}`).then(r => r.json()).then(d => {
        setPosts(d.posts || []);
        setPostCount(d.total_stored || 0);
        if (d.mechanical_filters) setMechanicalFilters(d.mechanical_filters);
        if (d.semantic_config) setSemanticConfig(d.semantic_config);
      }).catch(() => {});
    };
    poll();
    const iv = setInterval(poll, 5000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  async function send(text: string) {
    if (!text.trim() || loading) return;
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: text.trim() }]);
    setLoading(true);
    try {
      const feedId = await ensureServerFeed();
      const res = await authedFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text.trim(), feedId }),
      });
      const d = await res.json();
      const msgs = d.messages || [];
      setMessages(msgs);
      // Save chat history to Firestore
      if (activeFeedId) {
        saveChatMessagesToFirestore(profile.uid, activeFeedId, msgs).catch(() => {});
      }
      if (d.feed?.criteria) {
        const p = { description: d.feed.description, criteria: d.feed.criteria };
        setPrefs(p);
        checkNewFeed(p);
      }
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Something went wrong." }]);
    } finally { setLoading(false); }
  }

  async function startNewFeed() {
    // Create a fresh server-side feed
    const createRes = await authedFetch("/api/feeds", {
      method: "POST",
      body: JSON.stringify({ name: "Untitled" }),
    });
    if (!createRes.ok) {
      console.error("Failed to create feed", await createRes.text());
      return;
    }
    const createData = await createRes.json();
    const newServerId = createData.feed?.id ?? createData.id;
    if (newServerId == null) {
      console.error("No feed id in response", createData);
      return;
    }
    serverFeedIdRef.current = newServerId;

    // Immediately add an "Untitled" entry to the sidebar
    const newClientFeed: SavedFeed = {
      id: newServerId.toString(),
      name: "Untitled",
      color: FEED_COLORS[feeds.length % FEED_COLORS.length],
      criteria: { topics: [], keywords: [], exclude_topics: [], exclude_keywords: [], vibes: "" },
      createdAt: new Date().toISOString(),
    };
    const updated = [...feeds, newClientFeed];
    setFeeds(updated);
    saveFeeds(updated);
    saveFeedToFirestore(profile.uid, newClientFeed).catch(() => {});

    setMessages([]); setPrefs(null);
    setActiveFeedId(newClientFeed.id);
    setAddedVoices([]); setShowVoices(false);
    setMechanicalFilters(null);
    setSemanticConfig(null);
    setOnboardingActive(true);
    setView("chat");
  }

  async function selectFeed(feed: SavedFeed) {
    setActiveFeedId(feed.id);
    serverFeedIdRef.current = parseInt(feed.id) || null;
    setView("feed");
    // Load chat history from Firestore
    try {
      const msgs = await loadChatMessagesFromFirestore(profile.uid, feed.id);
      if (msgs.length > 0) setMessages(msgs as Message[]);
    } catch { /* ignore */ }
  }

  async function handleOnboardingComplete(config: SemanticConfig | null, feedName: string) {
    const feedId = serverFeedIdRef.current;
    if (!feedId) return;

    const safeConfig: SemanticConfig = config || { topics: [], keywords: [], exclude_topics: [], exclude_keywords: [], vibes: "", embedding_threshold: 0.72, judge_enabled: true, judge_strictness: "moderate" };

    // Update server-side feed
    try {
      await authedFetch("/api/feeds", {
        method: "PATCH",
        body: JSON.stringify({
          id: feedId,
          name: feedName,
          semantic_config: safeConfig,
          description: [...(safeConfig.topics || []), ...(safeConfig.keywords || []).slice(0, 5), safeConfig.vibes].filter(Boolean).join(", "),
        }),
      });
    } catch { /* ignore */ }

    // Update sidebar
    const updated = feeds.map(f =>
      f.id === feedId.toString()
        ? { ...f, name: feedName, criteria: { topics: safeConfig.topics || [], keywords: safeConfig.keywords || [], exclude_topics: safeConfig.exclude_topics || [], exclude_keywords: safeConfig.exclude_keywords || [], vibes: safeConfig.vibes || "" } }
        : f
    );
    setFeeds(updated);
    saveFeeds(updated);
    const updatedFeed = updated.find(f => f.id === feedId.toString());
    if (updatedFeed) saveFeedToFirestore(profile.uid, updatedFeed).catch(() => {});

    setSemanticConfig(safeConfig);
    setOnboardingActive(false);
    setView("feed");
  }

  function handleEscapeToChat() {
    setOnboardingActive(false);
    // Fall back to existing chat flow — send __init__
    const feedId = serverFeedIdRef.current;
    if (!feedId) return;
    setLoading(true);
    authedFetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "__init__", feedId }),
    })
      .then(r => r.json())
      .then(d => setMessages(d.messages || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  function confirmDeleteFeed() {
    if (!deleteTarget) return;
    const updated = feeds.filter(f => f.id !== deleteTarget);
    setFeeds(updated);
    saveFeeds(updated);
    deleteFeedFromFirestore(profile.uid, deleteTarget).catch(() => {});
    if (activeFeedId === deleteTarget) {
      setActiveFeedId(null);
      setView("chat");
    }
    setDeleteTarget(null);
  }

  function handleMemoryImported(importedFeed: { id: number; name: string; description: string; criteria: FeedCriteria; created_at: string; updated_at: string }) {
    const newFeed: SavedFeed = {
      id: importedFeed.id.toString(),
      name: importedFeed.name,
      color: FEED_COLORS[feeds.length % FEED_COLORS.length],
      criteria: importedFeed.criteria,
      createdAt: importedFeed.created_at,
    };
    const updated = [...feeds, newFeed];
    setFeeds(updated);
    saveFeeds(updated);
    saveFeedToFirestore(profile.uid, newFeed).catch(() => {});
    setActiveFeedId(newFeed.id);
    setShowImportMemory(false);
    setView("feed");
  }

  const hasCriteria =
    (prefs?.criteria &&
      ((prefs.criteria.topics?.length ?? 0) > 0 || (prefs.criteria.keywords?.length ?? 0) > 0)) ||
    (semanticConfig &&
      ((semanticConfig.topics?.length ?? 0) > 0 || (semanticConfig.keywords?.length ?? 0) > 0));

  const activeFeed = feeds.find(f => f.id === activeFeedId);
  const lastMsg = messages[messages.length - 1];
  const lastParsed = lastMsg?.role === "assistant" ? parseMessage(lastMsg.content) : null;

  if (!initialized) {
    return (
      <div className="curator-shell" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="cur-dots"><span /><span /><span /></div>
      </div>
    );
  }

  return (
    <div className="curator-shell">
      {/* SIDEBAR */}
      <div className="cur-sidebar">
        <div className="cur-sidebar-head">
          <Link href="/">
            <ShaderLogo height={32} />
          </Link>
        </div>

        <div className="cur-sidebar-label">Your Feeds · {feeds.length.toString().padStart(2, "0")}</div>

        <div className="cur-feed-list">
          {feeds.map((feed) => (
            <div
              key={feed.id}
              className={`cur-feed-item${activeFeedId === feed.id && view === "feed" ? " active" : ""}`}
              onClick={() => selectFeed(feed)}
            >
              <span className="swatch" style={{ background: feed.color }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="fi-name">{feed.name}</div>
                <div className="fi-sub">
                  {activeFeedId === feed.id ? `${postCount} posts · viewing` : `created ${new Date(feed.createdAt).toLocaleDateString()}`}
                </div>
              </div>
              <button
                className="cur-feed-delete"
                onClick={(e) => { e.stopPropagation(); setDeleteTarget(feed.id); }}
                title="Delete feed"
              >
                ×
              </button>
            </div>
          ))}

          {feeds.length === 0 && (
            <div style={{
              padding: "20px 12px",
              fontFamily: "var(--rf-body)",
              fontSize: 13,
              color: "var(--sage)",
              fontStyle: "italic",
            }}>
              No feeds yet — create your first one.
            </div>
          )}
        </div>

        <button className="cur-new-feed" onClick={startNewFeed}>
          + New feed
        </button>

        <div className="cur-sidebar-foot" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Link href="/">← Home</Link>
          <Dialog>
            <DialogTrigger className="cur-profile-btn" title="Profile">
              {profile.photoURL ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={profile.photoURL} alt="" className="cur-profile-photo" referrerPolicy="no-referrer" />
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
                </svg>
              )}
            </DialogTrigger>
            <DialogContent className="profile-dialog">
              <DialogHeader>
                <DialogTitle style={{ fontFamily: "var(--rf-display)", fontSize: 24, fontWeight: 400 }}>
                  Profile
                </DialogTitle>
              </DialogHeader>
              <Separator />
              <div className="profile-section">
                <div className="profile-label">Account</div>
                <div className="profile-row">
                  <span className="profile-key">Name</span>
                  <span className="profile-val">{profile.name}</span>
                </div>
                <div className="profile-row">
                  <span className="profile-key">Email</span>
                  <span className="profile-val">{profile.email}</span>
                </div>
              </div>
              <Separator />
              <div className="profile-section">
                <div className="profile-label">Bluesky</div>
                <div className="profile-row">
                  <span className="profile-key">Handle</span>
                  <span className="profile-val">{profile.blueskyHandle ? `@${profile.blueskyHandle}` : "Not connected"}</span>
                </div>
                <div className="profile-row">
                  <span className="profile-key">Connection</span>
                  <span className="profile-val" style={{ color: profile.blueskyHandle ? "var(--aurora)" : "var(--amber)" }}>
                    {profile.blueskyHandle ? "● Connected" : "○ Not linked"}
                  </span>
                </div>
                <div className="profile-row">
                  <span className="profile-key">Feed status</span>
                  <span className="profile-val">{hasCriteria ? "Active" : "Not configured"}</span>
                </div>
              </div>
              <Separator />
              <div className="profile-section">
                <div className="profile-label">Usage</div>
                <div className="profile-row">
                  <span className="profile-key">Posts scored</span>
                  <span className="profile-val">{postCount}</span>
                </div>
                <div className="profile-row">
                  <span className="profile-key">Feeds created</span>
                  <span className="profile-val">{feeds.length}</span>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* DELETE CONFIRMATION */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent className="profile-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle style={{ fontFamily: "var(--rf-display)", fontSize: 22, fontWeight: 400, color: "var(--cream)" }}>
              Delete this feed?
            </AlertDialogTitle>
            <AlertDialogDescription style={{ color: "var(--parchment-dim)", fontFamily: "var(--rf-body)", fontSize: 14 }}>
              This will permanently remove &ldquo;{feeds.find(f => f.id === deleteTarget)?.name}&rdquo; and its preferences. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel style={{
              background: "transparent", border: "1px solid var(--hair-strong)",
              color: "var(--parchment)", fontFamily: "var(--rf-mono)", fontSize: 10,
              letterSpacing: "0.1em", textTransform: "uppercase", borderRadius: 999,
            }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteFeed}
              style={{
                background: "var(--rose)", color: "var(--void)",
                fontFamily: "var(--rf-mono)", fontSize: 10,
                letterSpacing: "0.1em", textTransform: "uppercase", borderRadius: 999,
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* MAIN */}
      <div className="cur-main">
        <div className="cur-topbar">
          <div className="cur-topbar-left">
            <h2>
              {onboardingActive ? "Build your feed" : view === "chat" ? "Curate a feed" : (activeFeed?.name || "Your Feed")}
            </h2>
            {view === "feed" && (
              <span className="live-badge">live</span>
            )}
          </div>
          <div className="cur-topbar-right">
            {view === "chat" && hasCriteria && (
              <button
                onClick={() => setView("feed")}
                className="cur-topbar-btn filled"
              >
                View feed →
              </button>
            )}
            {view === "feed" && (
              <button
                onClick={() => setView("chat")}
                className="cur-topbar-btn ghost"
              >
                Edit preferences
              </button>
            )}
            <button
              onClick={() => setShowImportMemory(true)}
              className="cur-topbar-icon"
              title="Import AI memory"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
              </svg>
            </button>
            {hasCriteria && (
              <button
                onClick={() => setShowPublish(true)}
                className="cur-topbar-btn publish"
              >
                <svg width="14" height="14" viewBox="0 0 600 530" fill="currentColor">
                  <path d="M135.72 44.03C202.216 93.951 273.74 195.17 300 249.49c26.262-54.316 97.782-155.54 164.28-205.46C512.26 8.009 590-19.862 590 68.825c0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.38-3.69-10.832-3.708-7.896-.017-2.936-1.193.516-3.707 7.896-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.256 82.697-152.22-67.108 11.421-142.549-7.449-163.25-81.433C20.15 217.613 10 86.536 10 68.824c0-88.687 77.742-60.816 125.72-24.795z" />
                </svg>
                Publish
              </button>
            )}
          </div>
        </div>

        {view === "chat" && onboardingActive && serverFeedIdRef.current ? (
          <OnboardingFlow
            feedId={serverFeedIdRef.current}
            onComplete={handleOnboardingComplete}
            onEscapeToChat={handleEscapeToChat}
          />
        ) : view === "chat" ? (
          <>
            <div className="cur-chat-area">
              <div className="cur-chat-inner">
                {messages.map((msg, i) => {
                  const isUser = msg.role === "user";
                  const isLast = i === messages.length - 1;
                  const parsed = !isUser ? parseMessage(msg.content) : null;

                  return (
                    <div key={i} className="cur-msg">
                      {isUser ? (
                        <div className="cur-msg-user">{msg.content}</div>
                      ) : (
                        <div className="cur-msg-assistant">
                          {parsed!.text.split("\n\n").map((para, j) => (
                            <p key={j}>{para}</p>
                          ))}
                          {parsed!.options.length > 0 && (
                            <div className="cur-options">
                              {parsed!.options.map((opt) => (
                                <button
                                  key={opt.key}
                                  className="cur-opt"
                                  disabled={!isLast || loading}
                                  onClick={() => isLast && !loading && send(`${opt.key}. ${opt.label}`)}
                                >
                                  <span className="cur-opt-key">{opt.key}</span>
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {loading && (
                  <div className="cur-dots"><span /><span /><span /></div>
                )}

                {showVoices && (
                  <VoiceCards
                    onAddVoices={(voices) => {
                      setAddedVoices(voices);
                      setShowVoices(false);
                      // Send a message about the added voices
                      const names = voices.map(v => v.name).join(", ");
                      send(`Add these voices to my feed: ${names}`);
                    }}
                    onDismiss={() => {
                      setShowVoices(false);
                      setView("feed");
                    }}
                  />
                )}

                {addedVoices.length > 0 && !showVoices && (
                  <div className="cur-msg">
                    <div className="cur-msg-assistant">
                      <p style={{ fontSize: 13, color: "var(--aurora)" }}>
                        Added {addedVoices.length} voice{addedVoices.length !== 1 ? "s" : ""} to your feed: {addedVoices.map(v => v.name).join(", ")}
                      </p>
                    </div>
                  </div>
                )}

                <div ref={endRef} />
              </div>
            </div>

            <div className="cur-input-bar">
              <form className="cur-input-wrap" onSubmit={(e) => { e.preventDefault(); send(input); }}>
                <input
                  className="cur-input"
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={lastParsed?.options.length ? "Pick an option or type your own..." : "Describe your ideal feed..."}
                  disabled={loading}
                />
                <ShaderSendButton disabled={loading || !input.trim()} />
              </form>
            </div>
          </>
        ) : (
          <div className="cur-feed-layout">
            {/* Posts column */}
            <div className="cur-feed-posts">
              <div className="cur-feed-posts-inner">
                {posts.length === 0 ? (
                  <div className="cur-empty">
                    <p><span className="pulse-dot" />Listening to the firehose...</p>
                    <p className="sub">Posts matching your preferences will appear here as they come in.</p>
                    {!semanticConfig && (
                      <p className="sub" style={{ marginTop: 8, color: "var(--amber)" }}>
                        Complete the feed setup first — the worker needs your preferences to start matching.
                      </p>
                    )}
                  </div>
                ) : (
                  posts.map((post) => (
                    <div key={post.uri} className="cur-post">
                      <div className="cur-post-head">
                        <div className="avatar" />
                        <span className="handle">{post.author_did.slice(0, 24)}...</span>
                        <span className={`score ${post.score >= 0.6 ? "high" : post.score >= 0.4 ? "mid" : "low"}`}>
                          {(post.score * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="cur-post-body">{post.text}</div>
                      <div className="cur-post-time">{post.indexed_at}</div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Control tower */}
            {(mechanicalFilters || semanticConfig) && (
              <FilterPanel
                mechanicalFilters={mechanicalFilters || ({} as MechanicalFilters)}
                semanticConfig={semanticConfig || ({} as SemanticConfig)}
                onMechanicalChange={saveMechanicalFilters}
                onSemanticChange={saveSemanticConfig}
                postCount={postCount}
              />
            )}
          </div>
        )}
      </div>

      {showImportMemory && (
        <ImportMemoryModal
          onClose={() => setShowImportMemory(false)}
          onImported={handleMemoryImported}
        />
      )}

      {showPublish && (
        <PublishFeedModal
          onClose={() => setShowPublish(false)}
          blueskyHandle={profile.blueskyHandle}
          feedName={activeFeed?.name || "My Curated Feed"}
          feedDescription={activeFeed?.criteria.vibes || prefs?.criteria.vibes || "AI-curated feed based on my preferences"}
          feedId={serverFeedIdRef.current || undefined}
        />
      )}
    </div>
  );
}
