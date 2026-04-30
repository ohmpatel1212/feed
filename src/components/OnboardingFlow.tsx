"use client";

import { useState, useEffect, useCallback } from "react";
import ReversePrompting from "./ReversePrompting";
import TapCards, { type PostCard } from "./TapCards";
import TasteReveal from "./TasteReveal";
import { authedFetch } from "@/lib/authed-fetch";
import type { SemanticConfig } from "@/lib/types";

type Stage = "s1_prompting" | "s2_cards" | "s3_resolution" | "done";

interface OnboardingFlowProps {
  feedId: number;
  onComplete: (config: SemanticConfig, feedName: string) => void;
  onEscapeToChat: () => void;
}

interface S1State {
  botText: string;
  options: string[];
  domainPath: string[];
}

interface S3State {
  tasteStatements: { text: string }[];
  feedName: string;
  followUpQuestion: string | null;
  followUpOptions: string[];
}

export default function OnboardingFlow({
  feedId,
  onComplete,
  onEscapeToChat,
}: OnboardingFlowProps) {
  const [stage, setStage] = useState<Stage>("s1_prompting");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stage 1 state
  const [s1, setS1] = useState<S1State>({
    botText: "",
    options: [],
    domainPath: [],
  });

  // Stage 2 state
  const [cards, setCards] = useState<PostCard[]>([]);
  const [cardRound, setCardRound] = useState(1);
  const [commentary, setCommentary] = useState<string | null>(null);

  // Stage 3 state
  const [s3, setS3] = useState<S3State>({
    tasteStatements: [],
    feedName: "",
    followUpQuestion: null,
    followUpOptions: [],
  });

  // Progress dots
  const stageIndex = stage === "s1_prompting" ? 0 : stage === "s2_cards" ? 1 : 2;

  // --- Load persisted state on mount ---
  useEffect(() => {
    (async () => {
      try {
        const res = await authedFetch(`/api/onboarding?feedId=${feedId}`);
        const data = await res.json();
        const saved = data.state;
        if (!saved || !saved.stage) {
          // Fresh start — kick off stage 1
          startStage1();
          return;
        }

        // Restore state
        if (saved.stage === "s2_cards") {
          setStage("s2_cards");
          setCardRound((saved.s2Round as number || 0) + 1);
          // Fetch next round of cards
          fetchCards((saved.s2Round as number || 0) + 1);
        } else if (saved.stage === "s3_resolution") {
          setStage("s3_resolution");
          startStage3();
        } else {
          // Resume stage 1
          startStage1();
        }
      } catch {
        startStage1();
      }
    })();
  }, [feedId]);

  // --- Stage 1: Reverse Prompting ---

  async function startStage1() {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch("/api/onboarding", {
        method: "POST",
        body: JSON.stringify({ feedId, stage: "s1_prompting" }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setS1({
        botText: data.botText || "",
        options: data.options || [],
        domainPath: data.domainPath || [],
      });

      if (data.domainIdentified) {
        transitionToStage2();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleOptionSelected(option: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch("/api/onboarding", {
        method: "POST",
        body: JSON.stringify({
          feedId,
          stage: "s1_prompting",
          selectedOption: option,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setS1({
        botText: data.botText || "",
        options: data.options || [],
        domainPath: data.domainPath || [],
      });

      if (data.domainIdentified) {
        transitionToStage2();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // --- Stage 2: Card Selection ---

  function transitionToStage2() {
    setStage("s2_cards");
    setCardRound(1);
    setCommentary(null);
    fetchCards(1);
  }

  async function fetchCards(round: number) {
    setLoading(true);
    try {
      const res = await authedFetch("/api/onboarding", {
        method: "POST",
        body: JSON.stringify({ feedId, stage: "s2_cards", round }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setCards(data.cards || []);
      setCardRound(round);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCardRoundComplete(selectedUris: string[], skippedUris: string[]) {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch("/api/onboarding", {
        method: "POST",
        body: JSON.stringify({
          feedId,
          stage: "s2_cards",
          round: cardRound,
          selectedUris,
          skippedUris,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setCommentary(data.commentary || null);

      if (data.stageComplete) {
        // Move to stage 3
        setStage("s3_resolution");
        startStage3();
      } else if (data.cards) {
        // Next round
        setCards(data.cards);
        setCardRound(data.round);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // --- Stage 3: Ambiguity Resolution ---

  async function startStage3() {
    setLoading(true);
    try {
      const res = await authedFetch("/api/onboarding", {
        method: "POST",
        body: JSON.stringify({ feedId, stage: "s3_resolution" }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const statements = data.tasteStatements || [];
      const name = data.feedName || "My Feed";

      setS3({
        tasteStatements: statements,
        feedName: name,
        followUpQuestion: null,
        followUpOptions: [],
      });

      // If no statements were generated, auto-confirm
      if (statements.length === 0) {
        handleReactionsSubmitted([]);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleReactionsSubmitted(
    reactions: { text: string; reaction: "up" | "kinda" | "off" }[]
  ) {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch("/api/onboarding", {
        method: "POST",
        body: JSON.stringify({ feedId, stage: "s3_resolution", reactions }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      if (data.done) {
        onComplete(data.semanticConfig, data.feedName);
        return;
      }

      if (data.followUpQuestion) {
        setS3((prev) => ({
          ...prev,
          followUpQuestion: data.followUpQuestion,
          followUpOptions: data.followUpOptions || [],
        }));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleFollowUpAnswer(answer: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch("/api/onboarding", {
        method: "POST",
        body: JSON.stringify({
          feedId,
          stage: "s3_resolution",
          followUpAnswer: answer,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      if (data.done) {
        onComplete(data.semanticConfig, data.feedName);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function handleConfirm() {
    // Submit with all "up" reactions to finalize
    const reactions = s3.tasteStatements.map((s) => ({
      text: s.text,
      reaction: "up" as const,
    }));
    handleReactionsSubmitted(reactions);
  }

  return (
    <div className="ob-flow">
      {/* Progress indicator */}
      <div className="ob-progress">
        {["Explore", "Select", "Confirm"].map((label, i) => (
          <div key={i} className={`ob-progress-step ${i <= stageIndex ? "active" : ""} ${i === stageIndex ? "current" : ""}`}>
            <div className="ob-progress-dot" />
            <span className="ob-progress-label">{label}</span>
          </div>
        ))}
        <div className="ob-progress-line">
          <div className="ob-progress-fill" style={{ width: `${(stageIndex / 2) * 100}%` }} />
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="ob-error">
          {error}
          <button onClick={() => setError(null)}>&times;</button>
        </div>
      )}

      {/* Stage content */}
      {stage === "s1_prompting" && (
        <ReversePrompting
          botText={s1.botText}
          options={s1.options}
          domainPath={s1.domainPath}
          loading={loading}
          onOptionSelected={handleOptionSelected}
          onEscapeToChat={onEscapeToChat}
        />
      )}

      {stage === "s2_cards" && (
        <TapCards
          cards={cards}
          round={cardRound}
          totalRounds={3}
          botCommentary={commentary}
          loading={loading}
          onRoundComplete={handleCardRoundComplete}
        />
      )}

      {stage === "s3_resolution" && (
        <TasteReveal
          statements={s3.tasteStatements}
          feedName={s3.feedName}
          loading={loading}
          followUpQuestion={s3.followUpQuestion}
          followUpOptions={s3.followUpOptions}
          onReactionsSubmitted={handleReactionsSubmitted}
          onFollowUpAnswer={handleFollowUpAnswer}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
}
