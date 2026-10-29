import type { ReactElement } from "react";

/**
 * Local-pipeline voice matching knobs in plain language. Both values are sent
 * with the next local transcription of this meeting (they override the
 * global defaults from Settings for that run only).
 */
export function VoiceMatchingControls({
  similarity,
  onSimilarityChange,
  clustering,
  onClusteringChange,
  idPrefix,
}: {
  similarity: number;
  onSimilarityChange: (value: number) => void;
  clustering: number;
  onClusteringChange: (value: number) => void;
  idPrefix: string;
}): ReactElement {
  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={`${idPrefix}-similarity`}>How sure Olive must be before naming someone</label>
          <span className="font-mono text-xs text-base-content/50">{similarity.toFixed(2)}</span>
        </div>
        <input
          id={`${idPrefix}-similarity`}
          type="range"
          min="0.10"
          max="0.95"
          step="0.01"
          value={similarity}
          onChange={(e) => onSimilarityChange(parseFloat(e.target.value))}
          className="range range-xs range-primary w-full"
        />
        <div className="flex justify-between text-xs text-base-content/50">
          <span>Looser</span>
          <span>Stricter</span>
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={`${idPrefix}-clustering`}>How different two voices must sound to count as separate people</label>
          <span className="font-mono text-xs text-base-content/50">{clustering.toFixed(2)}</span>
        </div>
        <input
          id={`${idPrefix}-clustering`}
          type="range"
          min="0.10"
          max="0.95"
          step="0.01"
          value={clustering}
          onChange={(e) => onClusteringChange(parseFloat(e.target.value))}
          className="range range-xs range-primary w-full"
        />
        <div className="flex justify-between text-xs text-base-content/50">
          <span>Lower</span>
          <span>Higher</span>
        </div>
      </div>
      <p className="text-xs text-base-content/50">
        Applies the next time this meeting is transcribed with the local engine. Recommended: 0.45 and 0.50. Defaults live in Settings.
      </p>
    </div>
  );
}
