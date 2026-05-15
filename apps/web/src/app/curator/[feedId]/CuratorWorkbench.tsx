"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Script from "next/script";
import VoiceCards, { type Voice } from "@/components/VoiceCards";
import FilterPanel from "@/components/FilterPanel";
import ShaderSendButton from "@/components/ShaderSendButton";
import { authedFetch } from "@/lib/authed-fetch";
import type { MechanicalFilters, SemanticConfig } from "@/lib/types";
import { useResizable } from "../useResizable";
import { useCurator, feedIsComplete } from "../curatorContext";

interface Message { role: "user" | "assistant"; content: string; }
interface FeedCriteria {
  topics: string[]; keywords: string[];
  exclude_topics: string[]; exclude_keywords: string[];
  vibes: string;
}
interface Preferences { retrieval_query: string; criteria: FeedCriteria; }
interface Post {
  uri: string;
  author_did: string;
  text: string;
  score: number;
  indexed_at: string;
  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_cid: string | null;
  like_count: number;
  repost_count: number;
  reply_count: number;
  quote_count: number;
  external_uri: string | null;
  external_title: string | null;
  external_desc: string | null;
  quote_uri: string | null;
  has_images: boolean;
  image_count: number;
  image_alts: string[];
  is_reply: boolean;
  reply_parent_uri: string | null;
}

function avatarUrl(did: string, cid: string | null): string | null {
  if (!cid) return null;
  return `https://cdn.bsky.app/img/avatar_thumbnail/plain/${did}/${cid}@jpeg`;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function formatAbsoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function externalHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

type ViewMode = "card" | "embed";
const VIEW_MODE_KEY = "curator:viewMode";
const HIDE_UNAVAIL_KEY = "curator:hideUnavailable";
const RERANK_KEY = (feedId: number) => `curator:rerank:${feedId}`;
// How many posts to actually display per feed. Anything outside this window
// (e.g. reranker rejected items) stays mounted but display:none to keep
// Bluesky iframes alive across reranker toggles.
const DISPLAY_K = 50;

declare global {
  interface Window {
    bluesky?: { scan: (root?: Element | Document) => void };
  }
}

const RIGHT_W_KEY = "curator:rightWidth";
const RIGHT_MIN = 320;
const RIGHT_MAX = 720;

function parseMessage(content: string) {
  const stripped = content
    .replace(/FEED_NAME:.+\n?/g, "")
    .replace(/FEED_CONFIG_JSON:\s*\{[\s\S]*?\}\s*\n?/g, "")
    .replace(/MECHANICAL_FILTERS_JSON:\s*\{[\s\S]*?\}\s*\n?/g, "")
    .replace(/FEED_DONE\n?/g, "")
    .trim();
  const lines = stripped.split("\n");
  const options: { key: string; label: string }[] = [];
  const textLines: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d)\.\s+(.+)/);
    if (m) options.push({ key: m[1], label: m[2] });
    else textLines.push(line);
  }
  return { text: textLines.join("\n").trim(), options };
}

export default function CuratorWorkbench({ feedId }: { feedId: number }) {
  const {
    feeds,
    reloadFeeds,
    setActivePostCount,
    mobileTab,
    setMobileTab,
    setOptionsUnread,
  } = useCurator();

  const [rightPane, setRightPane] = useState<"chat" | "tune">("chat");
  const [rightWidth, startRightDrag] = useResizable(
    RIGHT_W_KEY, 380, RIGHT_MIN, RIGHT_MAX, "right"
  );

  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "card";
    const stored = window.localStorage.getItem(VIEW_MODE_KEY);
    return stored === "embed" ? "embed" : "card";
  });
  function setViewMode(next: ViewMode) {
    setViewModeState(next);
    try { window.localStorage.setItem(VIEW_MODE_KEY, next); } catch { /* ignore */ }
  }
  const [hideUnavailable, setHideUnavailableState] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(HIDE_UNAVAIL_KEY) !== "false";
  });
  function setHideUnavailable(next: boolean) {
    setHideUnavailableState(next);
    try { window.localStorage.setItem(HIDE_UNAVAIL_KEY, String(next)); } catch { /* ignore */ }
  }
  // Per-feed: unavailable URIs from the Bluesky availability probe. Lives
  // inside the workbench so it resets atomically when the feedId-keyed
  // component remounts on URL change.
  const [unavailableUris, setUnavailableUris] = useState<Set<string>>(() => new Set());
  const bskyAvailabilityCache = useRef<Map<string, boolean>>(new Map());

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [postCount, setPostCount] = useState(0);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsStage, setPostsStage] = useState<"idle" | "searching" | "ranking">("idle");

  // Reranker state. `vectorOrder` and `rerankedOrder` are URI lists; `posts`
  // holds the *union* of all posts referenced by either list so React keeps
  // them mounted across toggles (the iframes inside the embed wraps stay
  // alive even when their post falls out of the active top-50).
  const [vectorOrder, setVectorOrder] = useState<string[]>([]);
  const [rerankedOrder, setRerankedOrder] = useState<string[] | null>(null);
  const [rerankAvailable, setRerankAvailable] = useState(false);
  // The actual editorial paragraph the chat agent drafted, so the user
  // can read it from the curator instead of querying the DB directly.
  const [rerankPromptText, setRerankPromptText] = useState<string | null>(null);
  const [useRerank, setUseRerankState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(RERANK_KEY(feedId)) === "1";
  });
  function setUseRerank(next: boolean) {
    setUseRerankState(next);
    try {
      window.localStorage.setItem(RERANK_KEY(feedId), next ? "1" : "0");
    } catch { /* ignore */ }
  }
  const [rerankPhase, setRerankPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [rerankMs, setRerankMs] = useState<number | null>(null);
  const [rerankError, setRerankError] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const [prevCriteriaJson, setPrevCriteriaJson] = useState("");
  const [showVoices, setShowVoices] = useState(false);
  const [addedVoices, setAddedVoices] = useState<Voice[]>([]);
  const [mechanicalFilters, setMechanicalFilters] = useState<MechanicalFilters | null>(null);
  const [semanticConfig, setSemanticConfig] = useState<SemanticConfig | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const lastSemanticConfigJsonRef = useRef<string>("");
  const lastMechanicalFiltersJsonRef = useRef<string>("");
  const postsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On unmount (i.e. when the user switches feeds), clear the layout's
  // mirrored post count so the sidebar doesn't briefly show stale numbers
  // for the next feed. The active value is pushed up directly from
  // loadPosts (and from send() when FEED_DONE triggers a reload).
  useEffect(() => {
    return () => setActivePostCount(0);
  }, [setActivePostCount]);

  async function saveMechanicalFilters(filters: MechanicalFilters) {
    setMechanicalFilters(filters);
    try {
      await authedFetch("/api/feeds", {
        method: "PATCH",
        body: JSON.stringify({ id: feedId, mechanical_filters: filters }),
      });
    } catch { /* ignore */ }
  }

  async function saveSemanticConfig(config: SemanticConfig) {
    setSemanticConfig(config);
    try {
      await authedFetch("/api/feeds", {
        method: "PATCH",
        body: JSON.stringify({ id: feedId, semantic_config: config }),
      });
    } catch { /* ignore */ }
  }

  const loadChat = useCallback(async (id: number) => {
    setChatLoading(true);
    try {
      const res = await authedFetch(`/api/chat?feedId=${id}`);
      const data = await res.json();
      const msgs: Message[] = data.messages || [];
      if (data.feed?.criteria) {
        setPrefs({ retrieval_query: data.feed.retrieval_query, criteria: data.feed.criteria });
        setPrevCriteriaJson(JSON.stringify(data.feed.criteria));
      }
      setRerankAvailable(!!data.feed?.rerank_prompt);
      setRerankPromptText(data.feed?.rerank_prompt ?? null);
      setMessages(msgs);
    } catch { /* ignore */ }
    finally {
      setChatLoading(false);
    }
  }, []);

  const loadPosts = useCallback(async (id: number, opts?: { rerank?: boolean }) => {
    const wantsRerank = !!opts?.rerank;
    setPostsLoading(true);
    setPostsStage(wantsRerank ? "searching" : "searching");
    setRerankError(null);
    if (!wantsRerank) {
      // Plain JSON path — clear any prior rerank state so the curator falls
      // straight back to vector-only ordering on the next render.
      setRerankPhase("idle");
      setRerankMs(null);
      setRerankedOrder(null);
    }
    try {
      const url = wantsRerank
        ? `/api/feed-preview?feedId=${id}&rerank=1`
        : `/api/feed-preview?feedId=${id}`;
      const res = await authedFetch(url);
      const ct = res.headers.get("content-type") ?? "";

      if (ct.includes("ndjson") && res.body) {
        // Streaming path — two NDJSON lines, phase=vector then phase=rerank.
        setRerankPhase("running");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let obj: Record<string, unknown>;
            try { obj = JSON.parse(line); } catch { continue; }
            if (obj.phase === "vector") {
              const phasePosts = (obj.posts as Post[]) || [];
              const phaseOrder = (obj.vectorOrder as string[]) || [];
              setPosts(phasePosts);
              setVectorOrder(phaseOrder);
              setRerankedOrder(null);
              setPostCount(phasePosts.length);
              setActivePostCount(phasePosts.length);
              if (obj.mechanical_filters) setMechanicalFilters(obj.mechanical_filters as MechanicalFilters);
              if (obj.semantic_config) setSemanticConfig(obj.semantic_config as SemanticConfig);
              // Phase 1 done — let the user see results while phase 2 runs.
              setPostsLoading(false);
              setPostsStage("ranking");
            } else if (obj.phase === "rerank") {
              if (obj.error) {
                setRerankError(String(obj.error));
                setRerankPhase("error");
              } else {
                const extra = (obj.additionalPosts as Post[]) || [];
                if (extra.length > 0) {
                  setPosts((prev) => {
                    const seen = new Set(prev.map((p) => p.uri));
                    return [...prev, ...extra.filter((p) => !seen.has(p.uri))];
                  });
                }
                setRerankedOrder((obj.rerankedOrder as string[]) || []);
                setRerankMs(typeof obj.ms_rerank === "number" ? obj.ms_rerank : null);
                setRerankPhase("done");
              }
              setPostsStage("idle");
            }
          }
        }
      } else {
        // Plain JSON path.
        const d = await res.json();
        const nextCount = d.total_stored || (d.posts?.length ?? 0);
        const list = (d.posts as Post[]) || [];
        setPosts(list);
        setVectorOrder(list.map((p) => p.uri));
        setRerankedOrder(null);
        setPostCount(nextCount);
        setActivePostCount(nextCount);
        if (d.mechanical_filters) setMechanicalFilters(d.mechanical_filters);
        if (d.semantic_config) setSemanticConfig(d.semantic_config);
        setPostsLoading(false);
        setPostsStage("idle");
      }
    } catch (e) {
      setRerankError(e instanceof Error ? e.message : String(e));
    } finally {
      setPostsLoading(false);
      setPostsStage("idle");
    }
  }, [setActivePostCount]);

  // On mount (i.e. on feed switch via URL change), hydrate chat + posts.
  // Initial post load is always plain JSON (cheap, vector-only). If the user
  // has rerank enabled for this feed and the feed has a rerank_prompt, a
  // separate effect below upgrades to streaming once loadChat reveals that.
  useEffect(() => {
    loadChat(feedId);
    loadPosts(feedId);
  }, [feedId, loadChat, loadPosts]);

  // After chat loads we know rerankAvailable. If the user wants rerank and
  // we don't yet have a reranked order for this feed, fire the streaming
  // /api/feed-preview?rerank=1. Guards prevent double-fetching when this
  // effect re-runs (e.g. after rerankedOrder is set).
  const rerankInFlight = useRef(false);
  useEffect(() => {
    if (!useRerank || !rerankAvailable) return;
    if (rerankedOrder !== null) return;
    if (rerankInFlight.current) return;
    rerankInFlight.current = true;
    loadPosts(feedId, { rerank: true }).finally(() => {
      rerankInFlight.current = false;
    });
  }, [feedId, useRerank, rerankAvailable, rerankedOrder, loadPosts]);

  // Active ordering — vector by default, reranked if the user opted in and
  // we have rerank results. The orderMap is rebuilt only when the active
  // ordering changes; everything else (display:none toggles, post sort)
  // derives from it.
  const orderMap = useMemo(() => {
    const active = useRerank && rerankedOrder ? rerankedOrder : vectorOrder;
    const m = new Map<string, number>();
    active.forEach((uri, i) => m.set(uri, i));
    return m;
  }, [useRerank, rerankedOrder, vectorOrder]);

  // Sorted union — same React keys across toggles, just reordered. React
  // moves the existing DOM nodes instead of remounting, so the iframes
  // inside the embed wraps survive a rerank toggle.
  const sortedPosts = useMemo(() => {
    return [...posts].sort((a, b) => {
      const ra = orderMap.get(a.uri) ?? Number.POSITIVE_INFINITY;
      const rb = orderMap.get(b.uri) ?? Number.POSITIVE_INFINITY;
      return ra - rb;
    });
  }, [posts, orderMap]);

  // Watch for new criteria from the chat agent → refresh sidebar + show voices.
  const checkNewFeed = useCallback((newPrefs: Preferences) => {
    const newJson = JSON.stringify(newPrefs.criteria);
    const hasCriteria = (newPrefs.criteria.topics?.length ?? 0) > 0 ||
      (newPrefs.criteria.keywords?.length ?? 0) > 0;

    if (hasCriteria && newJson !== prevCriteriaJson) {
      setPrevCriteriaJson(newJson);
      setShowVoices(true);
      reloadFeeds();
    }
  }, [prevCriteriaJson, reloadFeeds]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Re-scan Bluesky embeds when the visible post set changes. We scan
  // regardless of viewMode because both Card and Embed wraps are always
  // mounted (see render-union below) — the embed placeholders just live
  // under a display:none ancestor when the user is viewing cards. The
  // bluesky widget's querySelectorAll still finds them and hydrates the
  // iframes once, so toggling viewMode never re-fetches from
  // embed.bsky.app.
  useEffect(() => {
    const scan = () => window.bluesky?.scan?.();
    scan();
    const t = setTimeout(scan, 300);
    return () => clearTimeout(t);
  }, [posts, hideUnavailable, unavailableUris]);

  // Detect unavailable posts via the public AT Proto API.
  useEffect(() => {
    if (posts.length === 0) return;

    const ac = new AbortController();
    const cache = bskyAvailabilityCache.current;

    async function check(uri: string) {
      const cached = cache.get(uri);
      if (cached !== undefined) {
        if (cached === false) {
          setUnavailableUris((prev) =>
            prev.has(uri) ? prev : new Set(prev).add(uri)
          );
        }
        return;
      }
      try {
        const res = await fetch(
          `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(
            uri
          )}&depth=0&parentHeight=0`,
          { signal: ac.signal }
        );
        if (!res.ok) {
          cache.set(uri, false);
          setUnavailableUris((prev) =>
            prev.has(uri) ? prev : new Set(prev).add(uri)
          );
          return;
        }
        const data = (await res.json()) as {
          thread?: {
            post?: {
              labels?: { val?: string }[];
              author?: { labels?: { val?: string }[] };
            };
          };
        };
        const post = data.thread?.post;
        const hasNoUnauth =
          post?.labels?.some((l) => l.val === "!no-unauthenticated") ||
          post?.author?.labels?.some((l) => l.val === "!no-unauthenticated") ||
          false;
        if (!post || hasNoUnauth) {
          cache.set(uri, false);
          setUnavailableUris((prev) =>
            prev.has(uri) ? prev : new Set(prev).add(uri)
          );
        } else {
          cache.set(uri, true);
        }
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
      }
    }

    posts.forEach((p) => { check(p.uri); });

    return () => ac.abort();
  }, [viewMode, posts]);

  async function send(text: string) {
    if (!text.trim() || loading) return;
    setInput("");
    setSelectedOptions(new Set());
    setMessages(prev => [...prev, { role: "user", content: text.trim() }]);
    setLoading(true);
    try {
      const res = await authedFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text.trim(), feedId }),
      });
      const d = await res.json();
      const msgs = d.messages || [];
      setMessages(msgs);
      if (d.feed?.criteria) {
        const p = { retrieval_query: d.feed.retrieval_query, criteria: d.feed.criteria };
        setPrefs(p);
        checkNewFeed(p);
      }
      // Reranker availability flips on as soon as the chat agent drafts
      // a rerank_prompt — usually on the very first turn. Without this
      // line the toggle would stay disabled until the user navigates
      // away and back, because rerankAvailable is only set on mount.
      if (d.feed) {
        setRerankAvailable(!!d.feed.rerank_prompt);
        setRerankPromptText(d.feed.rerank_prompt ?? null);
      }
      let configChanged = false;
      if (d.feed?.semantic_config) {
        const incomingJson = JSON.stringify(d.feed.semantic_config);
        if (incomingJson !== lastSemanticConfigJsonRef.current) {
          lastSemanticConfigJsonRef.current = incomingJson;
          setSemanticConfig(d.feed.semantic_config);
          configChanged = true;
        }
      }
      if (d.feed?.mechanical_filters) {
        const incomingJson = JSON.stringify(d.feed.mechanical_filters);
        if (incomingJson !== lastMechanicalFiltersJsonRef.current) {
          lastMechanicalFiltersJsonRef.current = incomingJson;
          setMechanicalFilters(d.feed.mechanical_filters);
          configChanged = true;
        }
      }
      if (configChanged) {
        if (postsDebounceRef.current) clearTimeout(postsDebounceRef.current);
        postsDebounceRef.current = setTimeout(() => {
          loadPosts(feedId);
        }, 600);
      }
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant" && parseMessage(last.content).options.length > 0) {
        if (mobileTab !== "chat") setOptionsUnread(true);
      }
      if (d.done) {
        loadPosts(feedId);
        reloadFeeds();
      }
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Something went wrong." }]);
    } finally { setLoading(false); }
  }

  // Cancel any pending debounce on unmount so a stale timer doesn't fire
  // after the user has navigated away.
  useEffect(() => {
    return () => {
      if (postsDebounceRef.current) {
        clearTimeout(postsDebounceRef.current);
        postsDebounceRef.current = null;
      }
    };
  }, []);

  function finalizeNow() {
    if (loading) return;
    send("Just go ahead and make my feed now with what you've got — pick reasonable defaults for anything we haven't covered yet.");
  }

  function askForQuestions() {
    if (loading) return;
    send("Help me build my prompt — walk me through it step by step and ask me questions to figure out what I want.");
  }

  function cancelQuestions() {
    if (loading) return;
    send("Cancel — stop with the questions, let me just chat freely.");
  }

  function submitChat() {
    const lastOptions = lastParsed?.options || [];
    const picks = lastOptions.filter((opt) => selectedOptions.has(opt.key));
    const comment = input.trim();
    if (picks.length === 0 && !comment) return;

    let composed = "";
    if (picks.length > 0) {
      composed = picks.map((p) => `${p.key}. ${p.label}`).join(", ");
    }
    if (comment) {
      composed = composed ? `${composed} — ${comment}` : comment;
    }
    send(composed);
  }

  const hasCriteria =
    (prefs?.criteria &&
      ((prefs.criteria.topics?.length ?? 0) > 0 || (prefs.criteria.keywords?.length ?? 0) > 0)) ||
    (semanticConfig &&
      ((semanticConfig.topics?.length ?? 0) > 0 || (semanticConfig.keywords?.length ?? 0) > 0));

  const activeFeed = feeds.find(f => f.id === String(feedId));
  const lastMsg = messages[messages.length - 1];
  const lastParsed = lastMsg?.role === "assistant" ? parseMessage(lastMsg.content) : null;

  const questionCount = messages.filter(
    (m) => m.role === "assistant" && parseMessage(m.content).options.length > 0
  ).length;
  const showFinalize = questionCount >= 3 && !hasCriteria;

  // Suppress unused-warning for activeFeed if we don't end up using it in JSX
  // (kept around in case future UI needs it).
  void activeFeed;
  void feedIsComplete;

  return (
    <>
      <Script
        src="https://embed.bsky.app/static/embed.js"
        strategy="afterInteractive"
        onLoad={() => window.bluesky?.scan?.()}
      />
      <div className="cur-workbench" data-right-pane={rightPane}>
        {/* POSTS PANE (middle) */}
        <div className="cur-feed-posts">
          <div className="cur-feed-posts-header">
            <div className="cur-feed-stage">
              {postsLoading && (
                <>
                  <span className="pulse-dot" />
                  <span>
                    {postsStage === "ranking"
                      ? "Ranking results…"
                      : "Searching for posts that match your feed…"}
                  </span>
                </>
              )}
            </div>
            <div className="cur-view-toggle" role="tablist" aria-label="Post view">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "card"}
                className={`cur-view-seg${viewMode === "card" ? " active" : ""}`}
                onClick={() => setViewMode("card")}
              >
                Cards
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "embed"}
                className={`cur-view-seg${viewMode === "embed" ? " active" : ""}`}
                onClick={() => setViewMode("embed")}
              >
                Bluesky embed
              </button>
            </div>
            {viewMode === "embed" && (
              <label
                className="cur-unavail-toggle"
                title="Hide posts whose Bluesky iframe renders the 'post not found / deleted' template"
              >
                <input
                  type="checkbox"
                  checked={hideUnavailable}
                  onChange={(e) => setHideUnavailable(e.target.checked)}
                />
                <span>
                  Hide unavailable
                  {unavailableUris.size > 0 && (
                    <span className="cur-unavail-count">
                      {" "}
                      ({unavailableUris.size})
                    </span>
                  )}
                </span>
              </label>
            )}
            <label
              className="cur-rerank-toggle"
              title={
                rerankAvailable
                  ? "Re-rank vector top-200 with Claude, using the editorial prompt this feed's chat agent drafted"
                  : "The chat agent hasn't drafted a rerank prompt for this feed yet"
              }
              aria-disabled={!rerankAvailable}
              style={{ opacity: rerankAvailable ? 1 : 0.4 }}
            >
              <input
                type="checkbox"
                checked={useRerank && rerankAvailable}
                disabled={!rerankAvailable}
                onChange={(e) => setUseRerank(e.target.checked)}
              />
              <span>Reranker</span>
            </label>
            <button
              type="button"
              className="cur-refresh"
              disabled={postsLoading}
              onClick={() => loadPosts(feedId, { rerank: useRerank && rerankAvailable })}
              title="Refresh posts"
            >
              ↻ Refresh
            </button>
          </div>
          {useRerank && rerankAvailable && rerankPhase === "running" && (
            <div className="cur-rerank-pill">
              <span className="pulse-dot" /> Reranking with Claude…
            </div>
          )}
          {useRerank && rerankAvailable && rerankPhase === "done" && rerankMs !== null && (
            <div className="cur-rerank-pill done">
              Reranked · {rerankMs}ms
            </div>
          )}
          {useRerank && rerankAvailable && rerankPhase === "error" && (
            <div className="cur-rerank-pill error" title={rerankError ?? undefined}>
              Reranker failed — showing vector order
            </div>
          )}
          <div className="cur-feed-posts-inner">
            {posts.length === 0 ? (
              <div className="cur-empty">
                {postsLoading ? (
                  <p><span className="pulse-dot" />Loading posts…</p>
                ) : (
                  <>
                    <p>No posts yet.</p>
                    <p className="sub">
                      {!hasCriteria
                        ? "Posts will appear here as we figure out what you're into."
                        : "Try Refresh, or refine the feed criteria in the chat."}
                    </p>
                  </>
                )}
              </div>
            ) : (
              sortedPosts.map((post) => {
                const bskyUrl = (() => {
                  const m = post.uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
                  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
                })();
                const replyParentUrl = (() => {
                  if (!post.reply_parent_uri) return null;
                  const m = post.reply_parent_uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
                  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
                })();
                const profileUrl = post.author_handle
                  ? `https://bsky.app/profile/${post.author_handle}`
                  : `https://bsky.app/profile/${post.author_did}`;
                const avatar = avatarUrl(post.author_did, post.author_avatar_cid);
                const displayName =
                  post.author_display_name?.trim() ||
                  post.author_handle ||
                  post.author_did.slice(0, 16) + "…";
                const handleLabel = post.author_handle
                  ? `@${post.author_handle}`
                  : post.author_did.slice(0, 20) + "…";
                const extHost = externalHost(post.external_uri);

                // Both wraps stay mounted; only one is visible. display:none on the
                // inactive wrap is what stops Bluesky's iframe from being destroyed
                // when the user toggles to Cards (the iframe is a child of the embed
                // wrap, so unmounting the wrap killed it; CSS-hiding leaves it alive).
                const embedHiddenByUnavail = hideUnavailable && unavailableUris.has(post.uri);
                const showEmbed = viewMode === "embed" && !embedHiddenByUnavail;
                const showCard = viewMode === "card";

                // Render-union: a post that's in the fetched union but
                // outside the active top-50 ordering stays mounted (so its
                // iframe never reloads on a future toggle) but is hidden.
                const rank = orderMap.get(post.uri);
                const inActiveTop = rank !== undefined && rank < DISPLAY_K;

                return (
                  <div
                    key={post.uri}
                    className="cur-post-slot"
                    style={{ display: inActiveTop ? undefined : "none" }}
                  >
                    <div
                      className="cur-post-embed-wrap"
                      data-bsky-uri={post.uri}
                      style={{ display: showEmbed ? undefined : "none" }}
                    >
                      {post.is_reply && (
                        <div className="cur-post-reply-banner cur-post-reply-banner-embed">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <polyline points="9 17 4 12 9 7" />
                            <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
                          </svg>
                          {replyParentUrl ? (
                            <a href={replyParentUrl} target="_blank" rel="noopener noreferrer">
                              Replying to a post
                            </a>
                          ) : (
                            <span>Reply</span>
                          )}
                        </div>
                      )}
                      <div className="cur-post-embed-meta">
                        <span
                          className={`cur-post-score ${post.score >= 0.6 ? "high" : post.score >= 0.4 ? "mid" : "low"}`}
                          title="Match score"
                        >
                          {(post.score * 100).toFixed(0)}%
                        </span>
                        {bskyUrl && (
                          <a
                            href={bskyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="cur-post-open"
                            title="Open in Bluesky"
                          >
                            Open ↗
                          </a>
                        )}
                      </div>
                      <div
                        className="bluesky-embed"
                        data-bluesky-uri={post.uri}
                        data-bluesky-embed-color-mode="light"
                      >
                        <p>{post.text}</p>
                        {bskyUrl && (
                          <p>
                            <a href={bskyUrl} target="_blank" rel="noopener noreferrer">
                              View on Bluesky
                            </a>
                          </p>
                        )}
                      </div>
                    </div>
                    <article
                      className="cur-post-card"
                      style={{ display: showCard ? undefined : "none" }}
                    >
                      {post.is_reply && (
                        <div className="cur-post-reply-banner">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <polyline points="9 17 4 12 9 7" />
                            <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
                          </svg>
                          {replyParentUrl ? (
                            <a href={replyParentUrl} target="_blank" rel="noopener noreferrer">
                              Replying to a post
                            </a>
                          ) : (
                            <span>Reply</span>
                          )}
                        </div>
                      )}
                      <header className="cur-post-card-head">
                        <a
                          href={profileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="cur-post-avatar"
                          aria-label={`Open ${displayName} on Bluesky`}
                        >
                          {avatar ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              src={avatar}
                              alt=""
                              referrerPolicy="no-referrer"
                              loading="lazy"
                            />
                          ) : (
                            <span className="cur-post-avatar-fallback" aria-hidden>
                              {(displayName[0] || "?").toUpperCase()}
                            </span>
                          )}
                        </a>
                        <div className="cur-post-author">
                          <a
                            href={profileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="cur-post-name"
                          >
                            {displayName}
                          </a>
                          <span className="cur-post-meta">
                            <a
                              href={profileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="cur-post-handle"
                            >
                              {handleLabel}
                            </a>
                            <span className="cur-post-meta-sep" aria-hidden>·</span>
                            <time
                              className="cur-post-time"
                              dateTime={post.indexed_at}
                              title={formatAbsoluteTime(post.indexed_at)}
                            >
                              {formatRelativeTime(post.indexed_at)}
                            </time>
                          </span>
                        </div>
                        <span
                          className={`cur-post-score ${post.score >= 0.6 ? "high" : post.score >= 0.4 ? "mid" : "low"}`}
                          title="Match score"
                        >
                          {(post.score * 100).toFixed(0)}%
                        </span>
                      </header>

                      <div className="cur-post-card-body">{post.text}</div>

                      {post.external_uri && (
                        <a
                          className="cur-post-embed"
                          href={post.external_uri}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <div className="cur-post-embed-host">{extHost || "link"}</div>
                          {post.external_title && (
                            <div className="cur-post-embed-title">{post.external_title}</div>
                          )}
                          {post.external_desc && (
                            <div className="cur-post-embed-desc">{post.external_desc}</div>
                          )}
                        </a>
                      )}

                      {post.quote_uri && !post.external_uri && (
                        <a
                          className="cur-post-embed quote"
                          href={(() => {
                            const m = post.quote_uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
                            return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : "#";
                          })()}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <div className="cur-post-embed-host">↳ quoted post</div>
                          <div className="cur-post-embed-desc">Open on Bluesky to view the quoted post.</div>
                        </a>
                      )}

                      {post.has_images && post.image_count > 0 && (
                        <div className="cur-post-images-note">
                          {post.image_count} image{post.image_count === 1 ? "" : "s"}
                          {post.image_alts.filter(Boolean).length > 0 && (
                            <span className="cur-post-images-alt">
                              {" — "}
                              {post.image_alts.filter(Boolean).join(" · ")}
                            </span>
                          )}
                        </div>
                      )}

                      <footer className="cur-post-stats">
                        <span className="cur-post-stat" title="Replies">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                          </svg>
                          {formatCount(post.reply_count)}
                        </span>
                        <span className="cur-post-stat" title="Reposts">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <polyline points="17 1 21 5 17 9" />
                            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                            <polyline points="7 23 3 19 7 15" />
                            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                          </svg>
                          {formatCount(post.repost_count)}
                        </span>
                        <span className="cur-post-stat" title="Likes">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                          </svg>
                          {formatCount(post.like_count)}
                        </span>
                        <span className="cur-post-stat" title="Quotes">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M3 21c3 0 5-2 5-5V7H3v8h4" />
                            <path d="M14 21c3 0 5-2 5-5V7h-5v8h4" />
                          </svg>
                          {formatCount(post.quote_count)}
                        </span>
                        {bskyUrl && (
                          <a
                            href={bskyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="cur-post-open"
                            title="Open in Bluesky"
                          >
                            Open ↗
                          </a>
                        )}
                      </footer>
                    </article>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* WORKBENCH RESIZER */}
        <div
          className="cur-resizer cur-resizer-workbench"
          onPointerDown={startRightDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize right pane"
        />

        {/* CHAT PANE (right, when rightPane === "chat") */}
        <div className="cur-chat-pane" style={{ ["--cur-right-w" as string]: `${rightWidth}px` }}>
          <div className="cur-right-toggle" role="tablist" aria-label="Workbench mode">
            <button
              type="button"
              role="tab"
              aria-selected={rightPane === "chat"}
              className={`cur-right-seg${rightPane === "chat" ? " active" : ""}`}
              onClick={() => setRightPane("chat")}
            >
              Chat
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightPane === "tune"}
              className={`cur-right-seg${rightPane === "tune" ? " active" : ""}`}
              onClick={() => setRightPane("tune")}
            >
              Tune
            </button>
          </div>
          <div className="cur-chat-area">
            <div className="cur-chat-inner">
              {messages.length === 0 && !chatLoading && !loading && (
                <div className="cur-empty">
                  <p>Describe your ideal feed</p>
                  <p className="sub">a topic you&rsquo;re interested in, hobbies, etc.</p>
                </div>
              )}
              {messages.map((msg, i) => {
                const isUser = msg.role === "user";
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
                      </div>
                    )}
                  </div>
                );
              })}
              {(loading || chatLoading) && (
                <div className="cur-dots"><span /><span /><span /></div>
              )}

              {showVoices && (
                <VoiceCards
                  onAddVoices={(voices) => {
                    setAddedVoices(voices);
                    setShowVoices(false);
                    const names = voices.map(v => v.name).join(", ");
                    send(`Add these voices to my feed: ${names}`);
                  }}
                  onDismiss={() => {
                    setShowVoices(false);
                    setMobileTab("feed");
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
            {lastParsed?.options.length ? (
              <div className="cur-pinned-options">
                {lastParsed.options.map((opt) => {
                  const checked = selectedOptions.has(opt.key);
                  const interactive = !loading;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      className={`cur-opt${checked ? " cur-opt-selected" : ""}`}
                      disabled={!interactive}
                      onClick={() => {
                        if (!interactive) return;
                        setSelectedOptions((prev) => {
                          const next = new Set(prev);
                          if (next.has(opt.key)) next.delete(opt.key);
                          else next.add(opt.key);
                          return next;
                        });
                      }}
                    >
                      <span className="cur-opt-key">{checked ? "✓" : opt.key}</span>
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {!hasCriteria && (
              <div className="cur-mode-row">
                {lastParsed?.options.length ? (
                  <>
                    <button
                      type="button"
                      className="cur-mode-toggle is-active"
                      onClick={cancelQuestions}
                      disabled={loading}
                    >
                      ✕ Cancel questions
                    </button>
                    <span className="cur-mode-hint">
                      go back to free-form chat
                    </span>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="cur-mode-toggle"
                      onClick={askForQuestions}
                      disabled={loading}
                    >
                      ✦ Help me build my prompt
                    </button>
                    <span className="cur-mode-hint">
                      let Claude ask you step-by-step questions
                    </span>
                  </>
                )}
              </div>
            )}
            {showFinalize && (
              <div className="cur-finalize-row">
                <button
                  type="button"
                  className="cur-finalize"
                  onClick={finalizeNow}
                  disabled={loading}
                >
                  ✦ Make this feed now
                </button>
                <span className="cur-finalize-hint">
                  skip the rest — Claude will use sensible defaults
                </span>
              </div>
            )}
            <form
              className="cur-input-wrap"
              onSubmit={(e) => {
                e.preventDefault();
                if (lastParsed?.options.length) submitChat();
                else send(input);
              }}
            >
              <textarea
                className="cur-input"
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (lastParsed?.options.length) submitChat();
                    else send(input);
                  }
                }}
                placeholder={
                  lastParsed?.options.length
                    ? selectedOptions.size > 0
                      ? "Add a comment (optional)…"
                      : "Tap the options above, or describe it in your own words…"
                    : "Describe your ideal feed…"
                }
                disabled={loading}
              />
              <ShaderSendButton
                disabled={
                  loading ||
                  (lastParsed?.options.length
                    ? selectedOptions.size === 0 && !input.trim()
                    : !input.trim())
                }
              />
            </form>
          </div>
        </div>

        {/* TUNE PANEL (right, when rightPane === "tune") */}
        <FilterPanel
          mechanicalFilters={mechanicalFilters || ({} as MechanicalFilters)}
          semanticConfig={semanticConfig || ({} as SemanticConfig)}
          onMechanicalChange={saveMechanicalFilters}
          onSemanticChange={saveSemanticConfig}
          postCount={postCount}
          rightPane={rightPane}
          onRightPaneChange={setRightPane}
          rerankPrompt={rerankPromptText}
          style={{ ["--cur-right-w" as string]: `${rightWidth}px` }}
        />
      </div>
    </>
  );
}
