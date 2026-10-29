import { useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Download, RefreshCw, Search, Upload, Users } from "lucide-react";
import { notify } from "../components/ui";
import type { SpeakerWithStats } from "../lib/common";
import { ActionMenu } from "./people/ActionMenu";
import { ImportLibraryDialog } from "./people/ImportLibraryDialog";
import { PersonDetail } from "./people/PersonDetail";
import { Avatar, MAX_VOICE_SAMPLES, VoiceDots, hasVoice, postJson, voiceSampleCount } from "./people/peopleUtils";

type PeopleFilter = "all" | "needsVoice";

export function SpeakersListView({
  speakers,
  onRefresh,
  onSelectMeeting
}: {
  speakers: SpeakerWithStats[];
  onRefresh: () => void;
  onSelectMeeting: (meetingId: string) => void;
}): ReactElement {
  // null = no explicit pick: mobile shows the list, desktop shows the first person.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<PeopleFilter>("all");
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState(false);

  const needsVoiceCount = useMemo(() => speakers.filter((s) => !hasVoice(s)).length, [speakers]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return speakers.filter((s) => (filter === "all" || !hasVoice(s)) && (!q || s.name.toLowerCase().includes(q)));
  }, [speakers, search, filter]);

  const explicit = selectedId ? speakers.find((s) => s.id === selectedId) ?? null : null;
  const shown = explicit ?? visible[0] ?? speakers[0] ?? null;

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      const res = await postJson<{ updated?: number; processed?: number }>("/api/speakers/backfill");
      notify("success", res.updated ? `Updated ${res.updated} voiceprint${res.updated === 1 ? "" : "s"}` : "All voiceprints are up to date");
      onRefresh();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to sync voiceprints");
    } finally {
      setSyncing(false);
    }
  };

  const libraryMenu = (
    <ActionMenu
      label="Library options"
      items={[
        {
          label: "Export voice library",
          description: "Voiceprints only, as a JSON file for another Olive",
          icon: <Download className="h-4 w-4" aria-hidden="true" />,
          onSelect: () => {
            const a = document.createElement("a");
            a.href = "/api/speakers/export?download=1";
            a.download = "olive-voiceprints.json";
            document.body.appendChild(a);
            a.click();
            a.remove();
          },
        },
        {
          label: "Import voice library…",
          description: "Preview before anything changes",
          icon: <Upload className="h-4 w-4" aria-hidden="true" />,
          onSelect: () => setImporting(true),
        },
        "divider",
        {
          label: syncing ? "Updating voiceprints…" : "Fill in missing voiceprints",
          description: "Learns a voiceprint for anyone with samples but none yet",
          icon: <RefreshCw className="h-4 w-4" aria-hidden="true" />,
          disabled: syncing,
          onSelect: () => void handleSyncAll(),
        },
      ]}
    />
  );

  const importDialog = importing && (
    <ImportLibraryDialog
      onClose={() => setImporting(false)}
      onImported={() => {
        setImporting(false);
        onRefresh();
      }}
    />
  );

  if (speakers.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">People</h1>
          {libraryMenu}
        </div>
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-base-300 px-6 py-16 text-center">
          <Users className="h-8 w-8 text-base-content/40" aria-hidden="true" />
          <p className="max-w-md text-base-content/70">
            No people yet. Open a meeting transcript and click a speaker label (for example S1) to name the person and teach Olive their voice.
          </p>
        </div>
        {importDialog}
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-8 lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-10">
      <section aria-label="People list" className={`min-w-0 flex-col gap-3 ${selectedId ? "hidden lg:flex" : "flex"}`}>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl lg:text-[22px]">People</h1>
          {libraryMenu}
        </div>
        <label className="flex h-11 items-center gap-2 rounded-md bg-hover px-2.5 text-base-content/60 focus-within:ring-1 focus-within:ring-primary/40 lg:h-[34px]">
          <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${speakers.length} ${speakers.length === 1 ? "person" : "people"}`}
            aria-label="Search people"
            className="w-full min-w-0 bg-transparent text-base-content outline-none placeholder:text-base-content/50"
          />
        </label>
        <div className="flex flex-wrap gap-1.5 text-[13px]" role="group" aria-label="Filter people">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            All
          </FilterChip>
          <FilterChip active={filter === "needsVoice"} onClick={() => setFilter("needsVoice")}>
            Needs a voice · {needsVoiceCount}
          </FilterChip>
        </div>

        <ul className="-mx-2 flex flex-col gap-0.5">
          {visible.length === 0 && (
            <li className="px-2 py-6 text-sm text-base-content/50">
              {filter === "needsVoice" && !search ? "Everyone has a voiceprint." : "Nobody matches your search."}
            </li>
          )}
          {visible.map((s) => {
            const count = voiceSampleCount(s);
            const isActive = shown?.id === s.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(s.id)}
                  aria-current={isActive ? "true" : undefined}
                  className={`flex min-h-[52px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition hover:bg-hover ${
                    isActive ? "lg:bg-active" : ""
                  }`}
                >
                  <Avatar speaker={s} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{s.name}</span>
                    <span className="truncate text-xs text-base-content/60">
                      {s.meetingCount} meeting{s.meetingCount === 1 ? "" : "s"} ·{" "}
                      {hasVoice(s) ? (count > 0 ? `voice ${count}/${MAX_VOICE_SAMPLES}` : "voiceprint") : "no voice yet"}
                    </span>
                  </span>
                  <VoiceDots count={count} />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div className={`min-w-0 ${selectedId ? "block" : "hidden lg:block"}`}>
        {shown && (
          <PersonDetail
            key={shown.id}
            speaker={shown}
            speakers={speakers}
            onRefresh={onRefresh}
            onSelectMeeting={onSelectMeeting}
            onBack={() => setSelectedId(null)}
            onRemoved={(nextId) => setSelectedId(nextId)}
          />
        )}
      </div>

      {importDialog}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-h-11 items-center rounded-full px-3 transition lg:min-h-7 ${
        active ? "bg-base-content text-base-100" : "border border-base-300 hover:bg-hover"
      }`}
    >
      {children}
    </button>
  );
}
