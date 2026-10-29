import { useState } from "react";
import type { ReactElement } from "react";
import { Pencil, Save } from "lucide-react";
import { Combobox } from "../components/Combobox";
import { confirmAction, notify } from "../components/ui";
import { SpeakerStatusBadges } from "../components/SpeakerCombobox";
import { SpeakerWithStats, formatDate } from "../lib/common";

export function SpeakersListView({
  speakers,
  onRefresh,
  onSelectMeeting
}: {
  speakers: SpeakerWithStats[];
  onRefresh: () => void;
  onSelectMeeting: (meetingId: string) => void;
}): ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [targetMergeId, setTargetMergeId] = useState("");
  const [syncing, setSyncing] = useState(false);

  const handleBackfill = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/speakers/backfill", { method: "POST" });
      if (res.ok) {
        onRefresh();
      }
    } catch {
      notify("error", "Failed to backfill voiceprints");
    } finally {
      setSyncing(false);
    }
  };

  const handleRename = async (id: string) => {
    if (!editingName.trim()) return;
    try {
      const res = await fetch(`/api/speakers/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: editingName.trim() })
      });
      if (res.ok) {
        setEditingId(null);
        onRefresh();
      }
    } catch {
      notify("error", "Failed to rename speaker");
    }
  };

  const handleMerge = async (sourceId: string) => {
    if (!targetMergeId) return;
    try {
      const res = await fetch("/api/speakers/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceSpeakerId: sourceId, targetSpeakerId: targetMergeId })
      });
      if (res.ok) {
        setMergingId(null);
        setTargetMergeId("");
        onRefresh();
      }
    } catch {
      notify("error", "Failed to merge speaker");
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!(await confirmAction({ title: "Delete speaker", message: `Are you sure you want to delete speaker "${name}"?`, confirmLabel: "Delete", danger: true }))) return;
    try {
      const res = await fetch(`/api/speakers/${id}`, { method: "DELETE" });
      if (res.ok) {
        onRefresh();
      }
    } catch {
      notify("error", "Failed to delete speaker");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">People & Voiceprints</h1>
          <p className="mt-1 text-sm text-base-content/70">
            Recognized speakers and their persistent voice identifiers learned from meetings.
          </p>
        </div>
        <div>
          <button
            type="button"
            disabled={syncing}
            onClick={() => void handleBackfill()}
            className="rounded-lg border border-base-300 bg-base-200 px-3.5 py-1.5 text-xs font-semibold text-base-content hover:border-primary hover:text-primary transition disabled:opacity-50"
          >
            {syncing ? "Syncing Voiceprints…" : "Sync & Cross-fill Voiceprints"}
          </button>
        </div>
      </div>

      {speakers.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-base-300 bg-base-200/40 py-16 text-center">
          <p className="text-base-content/70">
            No people enrolled yet. Open any meeting transcript and click a speaker label (e.g. S1) to assign a person and learn their voice.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {speakers.map((s) => {
            return (
              <div
                key={s.id}
                className="rounded-xl border border-base-300 bg-base-200/90 p-5 space-y-4 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-start justify-between">
                    {editingId === s.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          className="input input-md w-full min-w-0 rounded"
                        />
                        <button
                          type="button"
                          onClick={() => void handleRename(s.id)}
                          className="btn btn-primary min-h-[44px] shrink-0 rounded sm:min-h-0 sm:px-2 sm:py-1 sm:text-xs"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <h2 className="text-lg font-bold text-base-content flex items-center gap-2">
                        {s.name}
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(s.id);
                            setEditingName(s.name);
                          }}
                          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-xs text-base-content/50 hover:text-base-content sm:min-h-0 sm:min-w-0"
                        >
                          <Pencil className="h-4 w-4 shrink-0" aria-hidden="true" />
                        </button>
                      </h2>
                    )}
                    <div className="flex flex-col gap-1 items-end">
                      <SpeakerStatusBadges speaker={s} />
                    </div>
                  </div>

                  <div className="mt-3 space-y-1 text-xs text-base-content/70">
                    <p>Participated in: <span className="font-semibold text-base-content">{s.meetingCount} meeting(s)</span></p>
                    {s.enrollmentClipPaths?.length > 0 && (
                      <p>
                        Stored clips: <span className="font-semibold text-base-content">{s.enrollmentClipPaths.length}/8</span>
                        {s.enrollmentClipPaths.length >= 8 && (
                          <span className="text-base-content/50 ml-1">(Cap reached — auto-rolling)</span>
                        )}
                      </p>
                    )}
                    {s.enrolledAt && (
                      <p>Last learned: {formatDate(s.enrolledAt)}</p>
                    )}
                  </div>
                </div>

                {mergingId === s.id ? (
                  <div className="border-t border-base-300 pt-3 space-y-2">
                    <label className="text-xs text-base-content/70">Merge {s.name} into:</label>
                    <Combobox
                      value={targetMergeId}
                      onChange={setTargetMergeId}
                      placeholder="Select target…"
                      ariaLabel={`Merge ${s.name} into`}
                      searchPlaceholder="Search people…"
                      emptyText="No people match your search."
                      options={[
                        { value: "", label: "-- Choose target --" },
                        ...speakers
                          .filter((candidate) => candidate.id !== s.id)
                          .map((candidate) => ({
                            value: candidate.id,
                            label: candidate.name,
                          })),
                      ]}
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setMergingId(null)}
                        className="min-h-[44px] px-3 text-sm text-base-content/70 sm:min-h-0 sm:px-2 sm:py-1 sm:text-xs"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleMerge(s.id)}
                        className="btn btn-primary min-h-[44px] rounded sm:min-h-0 sm:px-2 sm:py-1 sm:text-xs"
                      >
                        Confirm Merge
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-stretch gap-2 border-t border-base-300/80 pt-3 text-xs text-base-content/70">
                    <button
                      type="button"
                      onClick={() => setMergingId(s.id)}
                      className="btn flex min-h-[44px] flex-1 items-center justify-center hover:border-primary hover:text-primary sm:min-h-0 sm:py-1.5 sm:text-xs"
                    >
                      Merge into…
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(s.id, s.name)}
                      className="btn flex min-h-[44px] flex-1 items-center justify-center hover:border-error/50 hover:text-error sm:min-h-0 sm:py-1.5 sm:text-xs"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
