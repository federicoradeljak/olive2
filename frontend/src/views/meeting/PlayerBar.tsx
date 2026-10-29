import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Pause, Play, RotateCcw, Sparkles, Volume1, Volume2, VolumeX } from "lucide-react";
import { formatClock, type TranscriptTurn } from "./transcript";
import { speakerTone } from "./kit";

export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

interface TimelineBlock {
  key: string;
  left: number;
  width: number;
  tone: string;
  speaker: string;
}

/** Collapse consecutive same-speaker turns into colored blocks for the seek bar. */
function timelineBlocks(turns: TranscriptTurn[], totalMs: number): TimelineBlock[] {
  if (totalMs <= 0 || turns.length === 0) return [];
  const blocks: TimelineBlock[] = [];
  let cur: { speaker: string; start: number; end: number } | null = null;
  const flush = () => {
    if (!cur) return;
    blocks.push({
      key: `${cur.speaker}-${cur.start}`,
      left: (cur.start / totalMs) * 100,
      width: Math.max(0.15, ((cur.end - cur.start) / totalMs) * 100),
      tone: speakerTone(cur.speaker),
      speaker: cur.speaker
    });
  };
  for (const t of turns) {
    if (cur && cur.speaker === t.speaker && t.startMs - cur.end < 2000) {
      cur.end = Math.max(cur.end, t.endMs);
    } else {
      flush();
      cur = { speaker: t.speaker, start: t.startMs, end: t.endMs };
    }
  }
  flush();
  return blocks;
}

/**
 * Sticky audio player: play/pause, skip back, current/total time, a seek bar
 * tinted by who is speaking, volume (desktop only), playback speed and the
 * enhanced-voice toggle.
 * Reads time straight from the <audio> element so the rest of the page does
 * not re-render on every tick.
 */
export function PlayerBar({
  audio,
  isPlaying,
  fallbackDurationMs,
  turns,
  enhanced,
  onToggleEnhanced,
  variant
}: {
  audio: HTMLAudioElement | null;
  isPlaying: boolean;
  fallbackDurationMs: number | null;
  turns: TranscriptTurn[];
  enhanced: boolean;
  onToggleEnhanced: () => void;
  variant: "desktop" | "mobile";
}): ReactElement {
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [rate, setRate] = useState<number>(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const rateRef = useRef(rate);
  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);

  useEffect(() => {
    if (!audio) return;
    const onTime = () => setCurrentMs(Math.round(audio.currentTime * 1000));
    const onMeta = () => {
      if (Number.isFinite(audio.duration)) setDurationMs(Math.round(audio.duration * 1000));
      audio.playbackRate = rateRef.current;
    };
    const onVolume = () => {
      setVolume(audio.volume);
      setMuted(audio.muted);
    };
    onTime();
    onMeta();
    onVolume();
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("seeked", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("volumechange", onVolume);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("seeked", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("volumechange", onVolume);
    };
  }, [audio]);

  const totalMs = durationMs ?? fallbackDurationMs ?? 0;
  const pct = totalMs > 0 ? Math.min(100, (currentMs / totalMs) * 100) : 0;
  const blocks = useMemo(() => timelineBlocks(turns, totalMs), [turns, totalMs]);

  const togglePlay = () => {
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  };
  const seek = (ms: number) => {
    if (!audio) return;
    audio.currentTime = Math.max(0, ms / 1000);
    setCurrentMs(ms);
  };
  const cycleRate = () => {
    const idx = PLAYBACK_RATES.indexOf(rate as (typeof PLAYBACK_RATES)[number]);
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    setRate(next);
    if (audio) audio.playbackRate = next;
  };
  const rateLabel = `${rate}×`;
  const changeVolume = (next: number) => {
    if (!audio) return;
    audio.volume = next;
    audio.muted = next === 0;
  };
  const toggleMute = () => {
    if (!audio) return;
    if (audio.muted || audio.volume === 0) {
      audio.muted = false;
      if (audio.volume === 0) audio.volume = 1;
    } else {
      audio.muted = true;
    }
  };
  const shownVolume = muted ? 0 : volume;
  const VolumeIcon = shownVolume === 0 ? VolumeX : shownVolume < 0.5 ? Volume1 : Volume2;

  const seekBar = (
    <div className="relative flex h-7 min-w-0 flex-1 items-center">
      <div className="absolute inset-x-0 h-1.5 overflow-hidden rounded-full bg-active">
        {blocks.map((b) => (
          <span
            key={b.key}
            className="absolute inset-y-0 opacity-45"
            style={{ left: `${b.left}%`, width: `${b.width}%`, background: `var(--tag-${b.tone})` }}
            title={b.speaker}
          />
        ))}
        <span className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span
        className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full border-2 border-base-100 bg-primary shadow"
        style={{ left: `${pct}%` }}
        aria-hidden="true"
      />
      <input
        type="range"
        min={0}
        max={Math.max(1, totalMs)}
        step={1000}
        value={Math.min(currentMs, Math.max(1, totalMs))}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Seek"
        aria-valuetext={`${formatClock(currentMs)} of ${formatClock(totalMs)}`}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </div>
  );

  const playButton = (size: string) => (
    <button
      type="button"
      onClick={togglePlay}
      aria-label={isPlaying ? "Pause" : "Play"}
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-base-content text-base-100 transition hover:opacity-90 ${size}`}
    >
      {isPlaying ? <Pause className="h-4 w-4" fill="currentColor" aria-hidden="true" /> : <Play className="h-4 w-4 translate-x-px" fill="currentColor" aria-hidden="true" />}
    </button>
  );

  if (variant === "mobile") {
    return (
      <div className="space-y-1 px-4 pt-1.5 pb-1">
        {seekBar}
        <div className="flex items-center gap-2">
          <span className="w-14 font-mono text-xs text-base-content/60">{formatClock(currentMs)}</span>
          <span className="flex-1" />
          <button type="button" onClick={() => seek(Math.max(0, currentMs - 15000))} aria-label="Back 15 seconds" className="btn btn-ghost btn-square h-11 w-11">
            <RotateCcw className="h-5 w-5" aria-hidden="true" />
          </button>
          {playButton("h-12 w-12")}
          <button type="button" onClick={cycleRate} aria-label={`Playback speed ${rateLabel}`} className="btn btn-ghost h-11 w-11 px-0 text-[13px] font-semibold">
            {rateLabel}
          </button>
          <span className="flex-1" />
          <span className="w-14 text-right font-mono text-xs text-base-content/60">{formatClock(totalMs)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[60px] items-center gap-3 px-5">
      {playButton("h-9 w-9")}
      <button type="button" onClick={() => seek(Math.max(0, currentMs - 15000))} aria-label="Back 15 seconds" title="Back 15 seconds" className="btn btn-ghost btn-square btn-sm text-base-content/60">
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
      </button>
      <span className="font-mono text-xs text-base-content/60 tabular-nums">{formatClock(currentMs)}</span>
      {seekBar}
      <span className="font-mono text-xs text-base-content/60 tabular-nums">{formatClock(totalMs)}</span>
      <div className="flex items-center">
        <button
          type="button"
          onClick={toggleMute}
          aria-label={shownVolume === 0 ? "Unmute" : "Mute"}
          title={shownVolume === 0 ? "Unmute" : "Mute"}
          className="btn btn-ghost btn-square btn-sm text-base-content/60"
        >
          <VolumeIcon className="h-4 w-4" aria-hidden="true" />
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={shownVolume}
          onChange={(e) => changeVolume(Number(e.target.value))}
          aria-label="Volume"
          aria-valuetext={`${Math.round(shownVolume * 100)}%`}
          className="range range-primary range-xs w-20"
        />
      </div>
      <button type="button" onClick={cycleRate} aria-label={`Playback speed ${rateLabel}`} title="Playback speed" className="btn btn-ghost btn-sm w-14 font-medium">
        {rateLabel}
      </button>
      <button
        type="button"
        aria-pressed={enhanced}
        onClick={onToggleEnhanced}
        title="Speech clarity filter and de-noiser"
        className={`btn btn-sm gap-1.5 border-0 font-medium ${enhanced ? "bg-primary/15 text-primary hover:bg-primary/20" : "btn-ghost text-base-content/60"}`}
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        Enhanced voice
      </button>
    </div>
  );
}
