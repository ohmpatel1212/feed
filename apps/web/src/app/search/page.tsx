"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import "./search.css";
import { authedFetch } from "@/lib/authed-fetch";
import type { VectorHit } from "@/lib/vector-search";

// ---------- shared types ----------

interface RerankPrompt {
  id: string;
  name: string;
  current_version: number | null;
  current_system_prompt: string | null;
}

interface RunSummary {
  id: string;
  query: string;
  vector_k: number;
  rerank_k: number;
  rerank_enabled: boolean;
  ms_total: number | null;
  created_at: string;
}

interface VectorPhase {
  phase: "vector";
  model: string;
  rerank_enabled: boolean;
  prompt: { id: string; version: number; name: string } | null;
  ms: { vector: number };
  hits: VectorHit[];
  error?: string;
}

interface RerankPhase {
  phase: "rerank";
  ms: { rerank: number | null; total: number };
  kept: { i: number; score: number; reason: string }[] | null;
  error?: string;
}

// ---------- helpers ----------

function atUriToEmbedUrl(uri: string): string | null {
  // at://did:plc:xxx/app.bsky.feed.post/rkey → https://embed.bsky.app/embed/did:plc:xxx/app.bsky.feed.post/rkey
  const m = uri.match(/^at:\/\/([^/]+)\/(app\.bsky\.feed\.post)\/(.+)$/);
  if (!m) return null;
  return `https://embed.bsky.app/embed/${m[1]}/${m[2]}/${m[3]}`;
}

function atUriToBskyUrl(uri: string): string | null {
  const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  if (!m) return null;
  return `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
}

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}

// ---------- bsky embed iframe with auto-resize ----------

function BskyEmbed({ uri }: { uri: string }) {
  const url = atUriToEmbedUrl(uri);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>(180);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (typeof ev.data !== "object" || ev.data === null) return;
      // Bluesky's embed posts { height: number } via postMessage.
      const data = ev.data as { height?: unknown };
      const h = typeof data.height === "number" ? data.height : null;
      if (h && iframeRef.current && ev.source === iframeRef.current.contentWindow) {
        setHeight(Math.max(180, Math.round(h)));
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!url) {
    return (
      <div className="srch-embed-wrap" style={{ minHeight: 100 }}>
        <div className="srch-embed-loading">unable to embed (post unavailable)</div>
      </div>
    );
  }

  return (
    <div className="srch-embed-wrap" style={{ minHeight: height }}>
      {!loaded && <div className="srch-embed-loading">loading post…</div>}
      <iframe
        ref={iframeRef}
        src={url}
        style={{ height }}
        onLoad={() => setLoaded(true)}
        scrolling="no"
        allowFullScreen
      />
    </div>
  );
}

// ---------- result row ----------

interface RowProps {
  hit: VectorHit;
  vectorRank: number;
  vectorTotal: number;
  rerankerScore: number | null;
  rerankerRank: number | null;
  rerankerTotal: number | null;
  reason: string | null;
  rerankEnabled: boolean;
}

function ResultRow(props: RowProps) {
  const { hit, vectorRank, vectorTotal, rerankerScore, rerankerRank, rerankerTotal, reason, rerankEnabled } = props;
  const bskyUrl = atUriToBskyUrl(hit.uri);

  return (
    <div className="srch-row">
      <BskyEmbed uri={hit.uri} />
      <div className="srch-info">
        <h6>Retrieval</h6>
        <div className="srch-info-grid">
          {rerankEnabled && (
            <>
              <span className="k">Reranker score</span>
              <span className={`v ${rerankerScore !== null ? "score" : "muted"}`}>
                {rerankerScore !== null ? rerankerScore : "—"}
              </span>
              <span className="k">Reranker rank</span>
              <span className={`v ${rerankerRank !== null ? "rank" : "muted"}`}>
                {rerankerRank !== null
                  ? `#${rerankerRank} / ${rerankerTotal}`
                  : "not in top set"}
              </span>
            </>
          )}
          <span className="k">Vector score</span>
          <span className="v score">{hit.vector_score.toFixed(3)}</span>
          <span className="k">Vector rank</span>
          <span className="v rank">{`#${vectorRank} / ${vectorTotal}`}</span>
        </div>

        {rerankEnabled && (
          <>
            <h6>Reason</h6>
            {reason ? (
              <div className="srch-reason">{reason}</div>
            ) : (
              <div className="srch-reason-empty">
                Reranker did not surface this item.
              </div>
            )}
          </>
        )}

        {bskyUrl && (
          <a
            className="srch-bsky-link"
            href={bskyUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            ↗ open on bsky.app
          </a>
        )}
      </div>
    </div>
  );
}

// ---------- main page ----------

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [vectorK, setVectorK] = useState(100);
  const [rerankK, setRerankK] = useState(25);
  const [rerankEnabled, setRerankEnabled] = useState(true);
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<RerankPrompt[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<"idle" | "vector" | "rerank" | "done">("idle");
  const [vectorPhase, setVectorPhase] = useState<VectorPhase | null>(null);
  const [rerankPhase, setRerankPhase] = useState<RerankPhase | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<"rerank" | "vector">("rerank");
  const inputRef = useRef<HTMLInputElement>(null);

  // initial fetch: prompts + recent runs
  useEffect(() => {
    (async () => {
      try {
        const [pRes, rRes] = await Promise.all([
          authedFetch("/api/rerank-prompts"),
          authedFetch("/api/search/runs"),
        ]);
        if (pRes.ok) {
          const data = await pRes.json();
          const arr: RerankPrompt[] = data.prompts || [];
          setPrompts(arr);
          if (arr.length > 0) setActivePromptId(arr[0].id);
        }
        if (rRes.ok) {
          const data = await rRes.json();
          setRuns(data.runs || []);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // ⌘K / Ctrl-K to focus input
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activePrompt = useMemo(
    () => prompts.find((p) => p.id === activePromptId) ?? null,
    [prompts, activePromptId]
  );

  // ---- main search ----
  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    if (rerankEnabled && !activePromptId) {
      setError("Pick a reranker prompt or turn the reranker off.");
      return;
    }

    setSubmitting(true);
    setPhase("vector");
    setVectorPhase(null);
    setRerankPhase(null);
    setError(null);
    setTab(rerankEnabled ? "rerank" : "vector");
    setActiveRunId(null);

    try {
      const res = await authedFetch("/api/search", {
        method: "POST",
        body: JSON.stringify({
          query: q,
          vector_k: vectorK,
          rerank_k: rerankK,
          rerank_enabled: rerankEnabled,
          prompt_id: rerankEnabled ? activePromptId : undefined,
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (typeof parsed !== "object" || parsed === null) continue;
          const obj = parsed as { phase?: string };
          if (obj.phase === "vector") {
            setVectorPhase(obj as unknown as VectorPhase);
            if (rerankEnabled) {
              setPhase("rerank");
            } else {
              setPhase("done");
            }
          } else if (obj.phase === "rerank") {
            setRerankPhase(obj as unknown as RerankPhase);
            setPhase("done");
          }
        }
      }
      // refresh runs list
      try {
        const rRes = await authedFetch("/api/search/runs");
        if (rRes.ok) {
          const data = await rRes.json();
          setRuns(data.runs || []);
        }
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    } finally {
      setSubmitting(false);
    }
  }, [query, vectorK, rerankK, rerankEnabled, activePromptId]);

  // ---- replay a saved run ----
  const replayRun = useCallback(async (id: string) => {
    setActiveRunId(id);
    setSubmitting(true);
    setPhase("vector");
    setVectorPhase(null);
    setRerankPhase(null);
    setError(null);
    try {
      const res = await authedFetch(`/api/search/runs/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const hits = (data.hits || []).filter(
        (h: { missing?: boolean }) => !h.missing
      ) as VectorHit[];
      setQuery(data.query);
      setVectorK(data.vector_k);
      setRerankK(data.rerank_k);
      setRerankEnabled(data.rerank_enabled);
      setTab(data.rerank_enabled ? "rerank" : "vector");
      setVectorPhase({
        phase: "vector",
        model: "claude-sonnet-4-6",
        rerank_enabled: data.rerank_enabled,
        prompt: null,
        ms: { vector: 0 },
        hits,
      });
      setRerankPhase({
        phase: "rerank",
        ms: { rerank: data.ms_rerank, total: data.ms_total ?? 0 },
        kept: data.kept,
      });
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    } finally {
      setSubmitting(false);
    }
  }, []);

  // ---- derived: which hits to render in which tab ----
  const hits = vectorPhase?.hits ?? [];
  const kept = rerankPhase?.kept ?? null;
  const keptByIdx = useMemo(() => {
    const m = new Map<number, { rank: number; score: number; reason: string }>();
    if (kept) {
      kept.forEach((k, rank) => {
        m.set(k.i, { rank: rank + 1, score: k.score, reason: k.reason });
      });
    }
    return m;
  }, [kept]);

  const rerankerTotal = kept?.length ?? null;
  const vectorTotal = hits.length;

  const rerankedRows: RowProps[] = useMemo(() => {
    if (!kept) return [];
    const out: RowProps[] = [];
    kept.forEach((k, rank) => {
      const hit = hits[k.i];
      if (!hit) return;
      out.push({
        hit,
        vectorRank: k.i + 1,
        vectorTotal,
        rerankerScore: k.score,
        rerankerRank: rank + 1,
        rerankerTotal,
        reason: k.reason,
        rerankEnabled: true,
      });
    });
    return out;
  }, [kept, hits, vectorTotal, rerankerTotal]);

  const vectorRows: RowProps[] = useMemo(() => {
    return hits.map((hit, idx) => {
      const rrk = keptByIdx.get(idx) ?? null;
      return {
        hit,
        vectorRank: idx + 1,
        vectorTotal,
        rerankerScore: rrk?.score ?? null,
        rerankerRank: rrk?.rank ?? null,
        rerankerTotal,
        reason: rrk?.reason ?? null,
        rerankEnabled: rerankEnabled,
      };
    });
  }, [hits, keptByIdx, vectorTotal, rerankerTotal, rerankEnabled]);

  const rowsToRender = tab === "rerank" ? rerankedRows : vectorRows;

  const modelLabel = vectorPhase?.model ?? "claude-sonnet-4-6";
  const totalMs =
    rerankPhase?.ms.total ??
    (vectorPhase ? vectorPhase.ms.vector : null);

  return (
    <div className="srch-shell">
      {/* ── LEFT RAIL ── */}
      <aside className="srch-rail">
        <div className="srch-rail-head">
          <Link href="/">Ripple <em>/search</em></Link>
        </div>

        <div className="srch-section-label">Recent runs</div>
        {runs.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--parchment-dim)" }}>
            No runs yet.
          </div>
        ) : (
          runs.map((r) => (
            <button
              key={r.id}
              className={`srch-run-item ${activeRunId === r.id ? "active" : ""}`}
              onClick={() => replayRun(r.id)}
            >
              {r.query}
              <span className="srch-run-meta">
                {timeAgo(r.created_at)} · {r.vector_k}
                {r.rerank_enabled ? `→${r.rerank_k}` : " · vector only"}
              </span>
            </button>
          ))
        )}

        <div className="srch-section-label">Saved prompts</div>
        {prompts.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--parchment-dim)" }}>
            No prompts saved yet.
          </div>
        ) : (
          prompts.map((p) => (
            <button
              key={p.id}
              className={`srch-prompt-item ${
                activePromptId === p.id ? "active" : ""
              }`}
              onClick={() => setActivePromptId(p.id)}
            >
              <span>{p.name}</span>
              <span className="tag">v{p.current_version ?? 1}</span>
            </button>
          ))
        )}
        <Link href="/search/prompts" className="srch-link">
          + New / manage prompts
        </Link>

        <div style={{ flex: 1 }} />
        <Link href="/" className="srch-link" style={{ marginTop: 24 }}>
          ← Back to Curator
        </Link>
      </aside>

      {/* ── CENTER ── */}
      <main className="srch-main">
        <div className="srch-input">
          <input
            ref={inputRef}
            type="text"
            placeholder="search for posts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
            }}
            autoFocus
          />
          <button onClick={runSearch} disabled={submitting || !query.trim()}>
            {submitting ? "Searching…" : "Search"}
          </button>
        </div>
        <div className="srch-input-hint">
          <span>⏎ search · ⌘K focus</span>
          <span>
            {totalMs !== null && phase === "done"
              ? `total ${totalMs}ms`
              : phase === "vector"
              ? "running vector search…"
              : phase === "rerank"
              ? `vector ${vectorPhase?.ms.vector}ms · reranking…`
              : ""}
          </span>
        </div>

        {error && <div className="srch-error">{error}</div>}

        <div className="srch-tabs">
          <button
            className={`srch-tab ${tab === "rerank" ? "active" : ""}`}
            onClick={() => setTab("rerank")}
            disabled={!vectorPhase?.rerank_enabled}
          >
            Reranked{" "}
            <span className="tab-count">
              {rerankPhase?.kept?.length ?? (vectorPhase?.rerank_enabled ? "…" : "—")}
            </span>
          </button>
          <button
            className={`srch-tab ${tab === "vector" ? "active" : ""}`}
            onClick={() => setTab("vector")}
          >
            Vector <span className="tab-count">{hits.length || "…"}</span>
          </button>
          <span
            className={`srch-model-pill ${
              vectorPhase?.rerank_enabled ? "" : "muted"
            }`}
            title={vectorPhase?.rerank_enabled ? "reranker model" : "reranker disabled"}
          >
            {vectorPhase?.rerank_enabled ? modelLabel : "vector only"}
          </span>
        </div>

        {phase === "rerank" && tab === "rerank" && !rerankPhase && (
          <div className="srch-progress">
            <span className="pulse" />
            <span>
              Claude {modelLabel} reranking {hits.length} candidates…
            </span>
          </div>
        )}

        <div className="srch-results">
          {phase === "idle" && (
            <div className="srch-empty">
              Type a query above. Vector search runs first, then the reranker.
            </div>
          )}
          {phase !== "idle" && rowsToRender.length === 0 && phase === "done" && (
            <div className="srch-empty">
              {tab === "rerank"
                ? "Reranker kept no items."
                : "Vector search returned no hits."}
            </div>
          )}
          {rowsToRender.map((row) => (
            <ResultRow key={row.hit.uri} {...row} />
          ))}
        </div>
      </main>

      {/* ── RIGHT RAIL ── */}
      <aside className="srch-rail right">
        <div className="srch-section-label">Knobs</div>

        <div className="srch-knob">
          <div className="srch-knob-head">
            <span className="srch-knob-label">Vector returns</span>
            <span className="srch-knob-val">{vectorK}</span>
          </div>
          <input
            type="range"
            min={10}
            max={200}
            step={5}
            value={vectorK}
            onChange={(e) => setVectorK(Number(e.target.value))}
          />
          <div
            style={{
              fontSize: 11,
              color: "var(--parchment-dim)",
              fontFamily: "var(--rf-mono)",
              marginTop: 4,
            }}
          >
            10 – 200
          </div>
        </div>

        <div className="srch-knob" style={{ opacity: rerankEnabled ? 1 : 0.5 }}>
          <div className="srch-knob-head">
            <span className="srch-knob-label">Reranker keeps</span>
            <span className="srch-knob-val">{rerankK}</span>
          </div>
          <input
            type="range"
            min={1}
            max={50}
            step={1}
            value={rerankK}
            onChange={(e) => setRerankK(Number(e.target.value))}
            disabled={!rerankEnabled}
          />
          <div
            style={{
              fontSize: 11,
              color: "var(--parchment-dim)",
              fontFamily: "var(--rf-mono)",
              marginTop: 4,
            }}
          >
            1 – 50
          </div>
        </div>

        <button
          className={`srch-toggle ${rerankEnabled ? "on" : ""}`}
          onClick={() => setRerankEnabled((v) => !v)}
          type="button"
        >
          <span className="srch-toggle-label">Use reranker</span>
          <span className="srch-toggle-track" />
        </button>

        {rerankEnabled && (
          <>
            <div className="srch-section-label">Active prompt</div>
            {activePrompt ? (
              <div className="srch-prompt-preview">
                <div className="srch-prompt-preview-head">
                  <span>{activePrompt.name}</span>
                  <span
                    style={{
                      color: "var(--parchment-dim)",
                      fontFamily: "var(--rf-mono)",
                      fontSize: 10,
                    }}
                  >
                    v{activePrompt.current_version ?? 1}
                  </span>
                </div>
                <div className="srch-prompt-preview-body">
                  {activePrompt.current_system_prompt}
                </div>
                <div className="srch-prompt-preview-actions">
                  <Link
                    href={`/search/prompts?id=${activePrompt.id}`}
                    className="srch-link"
                    style={{ marginTop: 0 }}
                  >
                    Edit
                  </Link>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--parchment-dim)" }}>
                No prompt selected.{" "}
                <Link href="/search/prompts" className="srch-link">
                  Create one →
                </Link>
              </div>
            )}
          </>
        )}

        <div className="srch-section-label" style={{ marginTop: 22 }}>
          Model
        </div>
        <div
          style={{
            fontFamily: "var(--rf-mono)",
            fontSize: 12,
            color: "var(--mist)",
            padding: "8px 12px",
            border: "1px solid var(--hair)",
            borderRadius: 6,
            background: "rgba(17,36,28,0.3)",
          }}
        >
          {rerankEnabled ? "claude-sonnet-4-6" : "vector only (no LLM)"}
        </div>

        <div className="srch-section-label" style={{ marginTop: 22 }}>
          Filters
        </div>
        <details className="srch-disclosure">
          <summary>Mechanical filters</summary>
          <div className="srch-disclosure-body">
            (lang, hashtags, min likes — coming soon)
          </div>
        </details>

        {phase === "done" && vectorPhase && (
          <>
            <div className="srch-section-label" style={{ marginTop: 22 }}>
              Timings
            </div>
            <div
              style={{
                fontFamily: "var(--rf-mono)",
                fontSize: 11.5,
                color: "var(--parchment)",
                lineHeight: 1.7,
              }}
            >
              <div>
                vector{"  "}
                {vectorPhase.ms.vector}ms
              </div>
              {rerankPhase?.ms.rerank !== null &&
                rerankPhase?.ms.rerank !== undefined && (
                  <div>
                    rerank{"  "}
                    {rerankPhase.ms.rerank}ms
                  </div>
                )}
              {rerankPhase && (
                <div
                  style={{
                    borderTop: "1px solid var(--hair)",
                    marginTop: 4,
                    paddingTop: 4,
                  }}
                >
                  total{"   "}
                  {rerankPhase.ms.total}ms
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
