import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { BadgeCheck, ChevronDown, ChevronUp, Ellipsis, Link2, Pencil, Play, Scissors, Search, UserX, X } from "lucide-react";
import { formatTimeOffset } from "../../lib/common";
import { Menu, speakerTone } from "./kit";
import { escapeRegExp, turnStatus, type TranscriptTurn } from "./transcript";

export interface TurnActions {
  onSeek: (ms: number) => void;
  onPlayTurnOnly: (turn: TranscriptTurn, idx: number) => void;
  onConfirm: (segmentIndex: number) => void;
  onChange: (turn: TranscriptTurn) => void;
  onSplitTurn: (turn: TranscriptTurn) => void;
  onMerge: (segmentIndex: number) => void;
  onUnassign: (segmentIndex: number) => void;
  onSplitMeetingHere: (ms: number) => void;
  splitAllowedAt: (ms: number) => boolean;
}

function Highlighted({ text, query }: { text: string; query: RegExp | null }): ReactElement {
  if (!query) return <>{text}</>;
  const parts = text.split(query);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-warning/30 px-0.5 text-inherit">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

const Turn = memo(function Turn({
  turn,
  idx,
  isLast,
  active,
  isCurrentMatch,
  segmentPlaying,
  query,
  isDesktop,
  actions
}: {
  turn: TranscriptTurn;
  idx: number;
  isLast: boolean;
  active: boolean;
  isCurrentMatch: boolean;
  segmentPlaying: boolean;
  query: RegExp | null;
  isDesktop: boolean;
  actions: TurnActions;
}): ReactElement {
  const status = turnStatus(turn);
  const tone = speakerTone(turn.speaker);
  const canConfirm = status === "likely";
  const changeLabel = status === "unknown" ? "Identify" : "Change";

  const menuItems = [
    !isDesktop && status !== "unknown"
      ? { key: "change", icon: <Pencil className="h-4 w-4" aria-hidden="true" />, label: "Change speaker…", onSelect: () => actions.onChange(turn) }
      : null,
    {
      key: "play",
      icon: <Play className="h-4 w-4" aria-hidden="true" />,
      label: segmentPlaying ? "Stop playing this turn" : "Play this turn only",
      onSelect: () => actions.onPlayTurnOnly(turn, idx)
    },
    { key: "split", icon: <Scissors className="h-4 w-4" aria-hidden="true" />, label: "Split turn…", onSelect: () => actions.onSplitTurn(turn) },
    !isLast ? { key: "merge", icon: <Link2 className="h-4 w-4" aria-hidden="true" />, label: "Merge with next turn", onSelect: () => actions.onMerge(turn.segmentIndex) } : null,
    turn.speaker !== "Unknown"
      ? {
          key: "wrong",
          icon: <UserX className="h-4 w-4" aria-hidden="true" />,
          label: "Wrong speaker (unassign)",
          title: "Reset this turn to Unknown",
          onSelect: () => actions.onUnassign(turn.segmentIndex)
        }
      : null,
    idx > 0 && actions.splitAllowedAt(turn.startMs) ? "divider" as const : null,
    idx > 0 && actions.splitAllowedAt(turn.startMs)
      ? {
          key: "split-meeting",
          icon: <Scissors className="h-4 w-4" aria-hidden="true" />,
          label: `Split meeting here (${formatTimeOffset(turn.startMs)})…`,
          onSelect: () => actions.onSplitMeetingHere(turn.startMs)
        }
      : null
  ];

  const moreMenu = (
    <Menu
      ariaLabel="More turn actions"
      menuClassName="min-w-[250px]"
      triggerClassName="btn btn-ghost btn-square btn-sm min-h-11 min-w-11 text-base-content/60 lg:min-h-7 lg:min-w-7 lg:h-7 lg:w-7"
      trigger={<Ellipsis className="h-4 w-4" aria-hidden="true" />}
      items={menuItems}
    />
  );

  const badge =
    status === "likely" ? (
      <span className="tag tag-yellow px-1.5 text-xs" title="Matched automatically from a saved voice — not confirmed yet">
        Likely match
      </span>
    ) : status === "unknown" ? (
      <span className="tag px-1.5 text-xs">Unknown voice</span>
    ) : null;

  const name = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-semibold" style={{ color: `var(--tag-${tone})` }}>
        {turn.speaker}
      </span>
      {turn.verified && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="Confirmed speaker" role="img" />}
    </span>
  );

  const rowClass = `rounded-lg transition-colors ${active ? "bg-primary/10" : isCurrentMatch ? "bg-warning/10" : "hover:bg-hover"}`;

  if (!isDesktop) {
    return (
      <div data-turn={idx} className={`flex flex-col gap-1 px-2 py-3 ${rowClass}`}>
        <div className="flex items-center gap-2">
          {name}
          <button
            type="button"
            onClick={() => actions.onSeek(turn.startMs)}
            aria-label={`Play from ${formatTimeOffset(turn.startMs)}`}
            className="min-h-11 shrink-0 px-1 font-mono text-xs text-base-content/50"
          >
            {formatTimeOffset(turn.startMs)}
          </button>
          {badge}
          <span className="flex-1" />
          {moreMenu}
        </div>
        <p className="break-words text-[15px] leading-relaxed">
          <Highlighted text={turn.text} query={query} />
        </p>
        {status !== "verified" && (
          <div className="mt-1 flex gap-2">
            {canConfirm ? (
              <>
                <button type="button" onClick={() => actions.onConfirm(turn.segmentIndex)} className="btn min-h-11 border-base-300 bg-base-100 px-4 font-medium">
                  Confirm
                </button>
                <button type="button" onClick={() => actions.onChange(turn)} className="btn btn-ghost min-h-11 px-4 font-normal text-base-content/60">
                  Change
                </button>
              </>
            ) : (
              <button type="button" onClick={() => actions.onChange(turn)} className="btn min-h-11 border-base-300 bg-base-100 px-4 font-medium">
                Identify
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-turn={idx} className={`grid grid-cols-[56px_minmax(0,1fr)_auto] gap-3 px-2.5 py-2.5 ${rowClass}`}>
      <button
        type="button"
        onClick={() => actions.onSeek(turn.startMs)}
        aria-label={`Play from ${formatTimeOffset(turn.startMs)}`}
        title="Play from here"
        className="h-6 self-start text-left font-mono text-xs text-base-content/50 hover:text-primary"
      >
        {formatTimeOffset(turn.startMs)}
      </button>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          {name}
          {badge}
        </span>
        <p className="break-words text-[15px] leading-relaxed">
          <Highlighted text={turn.text} query={query} />
        </p>
      </div>
      <div className="flex items-start gap-0.5">
        {canConfirm && (
          <button
            type="button"
            onClick={() => actions.onConfirm(turn.segmentIndex)}
            title="Confirm this speaker and teach Olive their voice"
            className="btn btn-xs h-7 border-base-300 bg-base-100 px-2 font-medium"
          >
            Confirm
          </button>
        )}
        <button
          type="button"
          onClick={() => actions.onChange(turn)}
          className={`btn btn-xs h-7 px-2 font-normal ${status === "unknown" ? "border-base-300 bg-base-100 font-medium" : "btn-ghost text-base-content/60"}`}
        >
          {changeLabel}
        </button>
        {moreMenu}
      </div>
    </div>
  );
});

export function TranscriptTab({
  turns,
  rawContent,
  activeTurnIdx,
  isPlaying,
  playingSegmentIndex,
  isDesktop,
  actions,
  emptyAction
}: {
  turns: TranscriptTurn[];
  rawContent: string | null;
  activeTurnIdx: number | null;
  isPlaying: boolean;
  playingSegmentIndex: number | null;
  isDesktop: boolean;
  actions: TurnActions;
  emptyAction: ReactNode;
}): ReactElement {
  const [search, setSearch] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [matchPos, setMatchPos] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const speakers = useMemo(() => [...new Set(turns.map((t) => t.speaker))], [turns]);
  const query = useMemo(() => {
    const q = search.trim();
    return q ? new RegExp(`(${escapeRegExp(q)})`, "gi") : null;
  }, [search]);

  const visible = useMemo(
    () => turns.map((t, idx) => ({ t, idx })).filter(({ t }) => !speakerFilter || t.speaker === speakerFilter),
    [turns, speakerFilter]
  );
  const matches = useMemo(() => {
    if (!query) return [] as number[];
    const q = search.trim().toLowerCase();
    return visible.filter(({ t }) => t.text.toLowerCase().includes(q)).map(({ idx }) => idx);
  }, [visible, query, search]);
  const currentMatch = matches.length > 0 ? matches[Math.min(matchPos, matches.length - 1)] : null;

  const scrollToTurn = (idx: number, behavior: ScrollBehavior = "smooth") => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-turn="${idx}"]`);
    el?.scrollIntoView({ block: "center", behavior });
  };

  useEffect(() => {
    setMatchPos(0);
  }, [search, speakerFilter]);

  useEffect(() => {
    if (currentMatch !== null) scrollToTurn(currentMatch);
  }, [currentMatch]);

  // Follow audio: keep the playing turn in view while audio plays.
  useEffect(() => {
    if (!follow || !isPlaying || activeTurnIdx === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-turn="${activeTurnIdx}"]`);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    if (rect.top < vh * 0.2 || rect.bottom > vh * 0.75) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeTurnIdx, follow, isPlaying]);

  const step = (delta: number) => {
    if (matches.length === 0) return;
    setMatchPos((p) => (p + delta + matches.length) % matches.length);
  };

  if (turns.length === 0) {
    if (rawContent) {
      return <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-box bg-base-200 p-4 font-sans text-sm">{rawContent}</pre>;
    }
    return (
      <div className="rounded-box border border-dashed border-base-300 px-6 py-10 text-center">
        <p className="font-medium">No transcript yet</p>
        <p className="mt-1 text-sm text-base-content/60">Transcribe the recording to see who said what.</p>
        <div className="mt-4">{emptyAction}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-11 min-w-0 flex-[1_1_220px] items-center gap-2 rounded-lg bg-hover px-2.5 text-base-content/60 lg:h-8 lg:max-w-xs">
          <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
              if (e.key === "Escape") setSearch("");
            }}
            placeholder="Search transcript"
            aria-label="Search transcript"
            className="w-full min-w-0 bg-transparent text-sm text-base-content outline-none placeholder:text-base-content/50 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <>
              <span className="shrink-0 font-mono text-xs" aria-live="polite">
                {matches.length === 0 ? "0" : `${Math.min(matchPos, matches.length - 1) + 1}/${matches.length}`}
              </span>
              <button type="button" onClick={() => step(-1)} aria-label="Previous match" className="btn btn-ghost btn-square btn-xs">
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button type="button" onClick={() => step(1)} aria-label="Next match" className="btn btn-ghost btn-square btn-xs">
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button type="button" onClick={() => setSearch("")} aria-label="Clear search" className="btn btn-ghost btn-square btn-xs">
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </>
          )}
        </label>
        <Menu
          ariaLabel="Filter by speaker"
          align="left"
          triggerClassName="btn btn-sm min-h-11 gap-1.5 border-base-300 bg-transparent font-normal lg:min-h-0"
          trigger={
            <>
              <span className="max-w-[10rem] truncate">{speakerFilter ?? "All speakers"}</span>
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </>
          }
          items={[
            { key: "__all", label: "All speakers", checked: speakerFilter === null, onSelect: () => setSpeakerFilter(null) },
            "divider",
            ...speakers.map((s) => ({
              key: s,
              label: (
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: `var(--tag-${speakerTone(s)})` }} aria-hidden="true" />
                  {s}
                </span>
              ),
              checked: speakerFilter === s,
              onSelect: () => setSpeakerFilter(s)
            }))
          ]}
        />
        <label className="ml-auto flex min-h-11 cursor-pointer items-center gap-2 text-[13px] text-base-content/60 lg:min-h-0">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="toggle toggle-primary toggle-xs" />
          Follow audio
        </label>
      </div>

      <div ref={listRef} className="flex flex-col">
        {visible.length === 0 && <p className="px-2 py-6 text-sm text-base-content/50">No turns for this speaker.</p>}
        {visible.map(({ t, idx }) => (
          <Turn
            key={`${t.segmentIndex}-${t.startMs}`}
            turn={t}
            idx={idx}
            isLast={idx === turns.length - 1}
            active={idx === activeTurnIdx}
            isCurrentMatch={idx === currentMatch}
            segmentPlaying={playingSegmentIndex === idx}
            query={query && t.text.toLowerCase().includes(search.trim().toLowerCase()) ? query : null}
            isDesktop={isDesktop}
            actions={actions}
          />
        ))}
      </div>
    </div>
  );
}

