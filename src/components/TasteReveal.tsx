"use client";

import { useState } from "react";

interface TasteStatement {
  text: string;
}

interface TasteRevealProps {
  statements: TasteStatement[];
  feedName: string;
  loading: boolean;
  followUpQuestion: string | null;
  followUpOptions: string[];
  onReactionsSubmitted: (reactions: { text: string; reaction: "up" | "kinda" | "off" }[]) => void;
  onFollowUpAnswer: (answer: string) => void;
  onConfirm: () => void;
}

type Reaction = "up" | "kinda" | "off" | null;

export default function TasteReveal({
  statements,
  feedName,
  loading,
  followUpQuestion,
  followUpOptions,
  onReactionsSubmitted,
  onFollowUpAnswer,
  onConfirm,
}: TasteRevealProps) {
  const [reactions, setReactions] = useState<Reaction[]>(
    statements.map(() => null)
  );
  const [submitted, setSubmitted] = useState(false);
  const [creators, setCreators] = useState("");
  const [showCreators, setShowCreators] = useState(false);

  function setReaction(index: number, reaction: Reaction) {
    setReactions((prev) => {
      const next = [...prev];
      next[index] = reaction;
      return next;
    });
  }

  function handleSubmitReactions() {
    const result = statements.map((s, i) => ({
      text: s.text,
      reaction: reactions[i] || ("up" as const),
    }));
    setSubmitted(true);
    onReactionsSubmitted(result);
  }

  const allReacted = reactions.every((r) => r !== null);

  // Follow-up mode
  if (followUpQuestion) {
    return (
      <div className="ob-stage ob-stage-reveal">
        <div className="ob-bot-text">
          <p>{followUpQuestion}</p>
        </div>
        {followUpOptions.length > 0 && (
          <div className="ob-options">
            {followUpOptions.map((opt, i) => (
              <button
                key={i}
                className="ob-opt"
                onClick={() => onFollowUpAnswer(opt)}
                disabled={loading}
              >
                <span className="ob-opt-key">{i + 1}</span>
                {opt}
              </button>
            ))}
          </div>
        )}
        {loading && (
          <div className="cur-dots"><span /><span /><span /></div>
        )}
      </div>
    );
  }

  return (
    <div className="ob-stage ob-stage-reveal">
      <div className="ob-reveal-header">
        <h3>Here&rsquo;s what I&rsquo;m picking up</h3>
        <span className="ob-feed-name">{feedName}</span>
      </div>

      {/* Taste statements with reactions */}
      <div className="ob-taste-list">
        {statements.map((stmt, i) => (
          <div key={i} className="ob-taste-card">
            <p className="ob-taste-text">{stmt.text}</p>
            {!submitted && (
              <div className="ob-taste-reactions">
                <button
                  className={`ob-react ${reactions[i] === "up" ? "active-up" : ""}`}
                  onClick={() => setReaction(i, "up")}
                  title="Yes, that's me"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </button>
                <button
                  className={`ob-react ${reactions[i] === "kinda" ? "active-kinda" : ""}`}
                  onClick={() => setReaction(i, "kinda")}
                  title="Kinda"
                >
                  ~
                </button>
                <button
                  className={`ob-react ${reactions[i] === "off" ? "active-off" : ""}`}
                  onClick={() => setReaction(i, "off")}
                  title="That's off"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Submit reactions or confirm */}
      {!submitted && allReacted && (
        <button className="ob-confirm-btn" onClick={handleSubmitReactions} disabled={loading}>
          {reactions.some((r) => r === "off") ? "Submit feedback" : "Looks right"}
        </button>
      )}

      {submitted && !loading && (
        <div className="ob-final-section">
          {/* Optional creators input */}
          {!showCreators ? (
            <button className="ob-creators-toggle" onClick={() => setShowCreators(true)}>
              Any creators you already like? (optional)
            </button>
          ) : (
            <div className="ob-creators-input">
              <input
                type="text"
                value={creators}
                onChange={(e) => setCreators(e.target.value)}
                placeholder="@username, @another..."
                className="ob-input"
              />
              <button className="ob-skip-btn" onClick={() => setShowCreators(false)}>
                Skip
              </button>
            </div>
          )}

          <button className="ob-create-btn" onClick={onConfirm} disabled={loading}>
            Create my feed
          </button>
        </div>
      )}

      {loading && (
        <div className="cur-dots"><span /><span /><span /></div>
      )}
    </div>
  );
}
