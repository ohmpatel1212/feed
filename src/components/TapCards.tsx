"use client";

import { useState, useCallback } from "react";
import { CardSpotlight } from "@/components/ui/card-spotlight";

export interface PostCard {
  id: number;
  uri: string;
  text: string;
  author_handle: string;
  topic_cluster: string;
  vibe_tags: string[];
  format: string;
}

interface TapCardsProps {
  cards: PostCard[];
  round: number;
  totalRounds: number;
  botCommentary: string | null;
  loading: boolean;
  onRoundComplete: (selectedUris: string[], skippedUris: string[]) => void;
}

export default function TapCards({
  cards,
  round,
  totalRounds,
  botCommentary,
  loading,
  onRoundComplete,
}: TapCardsProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = useCallback((uri: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  }, []);

  function handleDone() {
    const selectedUris = cards.filter((c) => selected.has(c.uri)).map((c) => c.uri);
    const skippedUris = cards.filter((c) => !selected.has(c.uri)).map((c) => c.uri);
    onRoundComplete(selectedUris, skippedUris);
    setSelected(new Set());
  }

  return (
    <div className="ob-stage ob-stage-cards">
      {/* Round indicator */}
      <div className="ob-round-header">
        <span className="ob-round-label">Round {round} of {totalRounds}</span>
        <span className="ob-round-hint">
          Tap the posts that would make you stop scrolling
        </span>
      </div>

      {/* Bot commentary from previous round */}
      {botCommentary && (
        <div className="ob-bot-text ob-commentary">
          <p>{botCommentary}</p>
        </div>
      )}

      {loading ? (
        <div className="cur-dots" style={{ padding: "40px 0" }}><span /><span /><span /></div>
      ) : (
        <>
          {/* Card grid */}
          <div className="ob-card-grid">
            {cards.map((card) => {
              const isSelected = selected.has(card.uri);
              return (
                <CardSpotlight
                  key={card.uri}
                  className={`ob-card ${isSelected ? "selected" : ""}`}
                  radius={200}
                  color={isSelected ? "rgba(125, 203, 165, 0.15)" : "rgba(232, 185, 136, 0.08)"}
                  onClick={() => toggle(card.uri)}
                >
                  <div className="ob-card-text relative z-10">
                    {card.text.length > 200
                      ? card.text.slice(0, 200) + "..."
                      : card.text}
                  </div>
                  <div className="ob-card-meta relative z-10">
                    <span className="ob-card-handle">@{card.author_handle}</span>
                    <span className="ob-card-format">{card.format}</span>
                  </div>
                  <div className="ob-card-check relative z-10">
                    {isSelected ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    )}
                  </div>
                </CardSpotlight>
              );
            })}
          </div>

          {/* Footer */}
          <div className="ob-card-footer">
            <span className="ob-card-count">
              {selected.size > 0
                ? `${selected.size} selected`
                : "Tap posts you like — skip is fine too"}
            </span>
            <button
              className="ob-card-done"
              onClick={handleDone}
              disabled={loading}
            >
              {selected.size === 0 ? "Skip this round" : "Done"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
