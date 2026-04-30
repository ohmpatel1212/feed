"use client";

import { useState } from "react";

interface ReversePromptingProps {
  botText: string;
  options: string[];
  domainPath: string[];
  loading: boolean;
  onOptionSelected: (option: string) => void;
  onEscapeToChat: () => void;
}

export default function ReversePrompting({
  botText,
  options,
  domainPath,
  loading,
  onOptionSelected,
  onEscapeToChat,
}: ReversePromptingProps) {
  return (
    <div className="ob-stage ob-stage-prompting">
      {/* Breadcrumb trail */}
      {domainPath.length > 0 && (
        <div className="ob-breadcrumb">
          {domainPath.map((step, i) => (
            <span key={i}>
              {i > 0 && <span className="ob-breadcrumb-sep">&rsaquo;</span>}
              <span className={i === domainPath.length - 1 ? "ob-breadcrumb-active" : ""}>
                {step}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* Bot text */}
      <div className="ob-bot-text">
        {botText.split("\n\n").map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </div>

      {/* Options */}
      {!loading && options.length > 0 && (
        <div className="ob-options">
          {options.map((opt, i) => (
            <button
              key={i}
              className="ob-opt"
              onClick={() => onOptionSelected(opt)}
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

      {/* Escape hatch */}
      <button className="ob-escape" onClick={onEscapeToChat}>
        I&rsquo;d rather just describe it myself
      </button>
    </div>
  );
}
