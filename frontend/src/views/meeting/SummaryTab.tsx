import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown, ClipboardCopy, Download, Ellipsis, Star, Trash2 } from "lucide-react";
import type { LlmModelCatalogItem, MeetingSummaryItem, SummaryGenerationStatus } from "../../api/types.ts";
import { MarkdownRenderer, formatDate } from "../../lib/common";
import { Menu, Segmented, Spinner, downloadText, safeFilename } from "./kit";
import { formatShortDate, summaryLabel } from "./transcript";

/** Display names for summary models, keyed by `provider:id`. */
export function useModelNames(): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/llm/models")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { models?: LlmModelCatalogItem[] } | null) => {
        if (cancelled || !data?.models) return;
        setNames(new Map(data.models.map((m) => [`${m.provider}:${m.id}`, m.name])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return names;
}

export function summaryDisplay(summary: MeetingSummaryItem, modelNames: Map<string, string>): { template: string; detail: string } {
  const label = summaryLabel(summary);
  const model = modelNames.get(`${label.provider}:${label.model}`) ?? label.model ?? label.provider;
  return { template: label.template, detail: [model, formatShortDate(summary.createdAt)].filter(Boolean).join(" · ") };
}

export async function copySummary(content: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    return false;
  }
}

export function downloadSummary(meetingTitle: string, summary: MeetingSummaryItem): void {
  const { template } = summaryLabel(summary);
  downloadText(`${safeFilename(meetingTitle)} - ${safeFilename(template)}.md`, summary.content, "text/markdown");
}

/**
 * Markdown with GitHub task-list items turned into real checkboxes. Checking
 * them is local UI state only — nothing is persisted.
 */
function SummaryMarkdown({ content }: { content: string }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const cleanups: Array<() => void> = [];
    root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
      input.disabled = false;
      input.className = "checkbox checkbox-sm checkbox-primary mr-2 align-[-3px]";
      const li = input.closest("li");
      if (li) li.classList.add("list-none", "-ml-5");
      const sync = () => {
        if (!li) return;
        li.classList.toggle("line-through", input.checked);
        li.classList.toggle("text-base-content/50", input.checked);
      };
      sync();
      input.addEventListener("change", sync);
      cleanups.push(() => input.removeEventListener("change", sync));
    });
    return () => cleanups.forEach((fn) => fn());
  }, [content]);

  return (
    <div ref={ref}>
      <MarkdownRenderer content={content} className="text-[15px] leading-relaxed" />
    </div>
  );
}

export function SummaryTab({
  meetingTitle,
  summaries,
  activeSummary,
  generation,
  canGenerate,
  modelNames,
  onSelect,
  onSetPrimary,
  onDelete,
  onNewSummary,
  onCopied
}: {
  meetingTitle: string;
  summaries: MeetingSummaryItem[];
  activeSummary: MeetingSummaryItem | null;
  generation: SummaryGenerationStatus | null;
  canGenerate: boolean;
  modelNames: Map<string, string>;
  onSelect: (id: string) => void;
  onSetPrimary: (id: string) => void;
  onDelete: (id: string) => void;
  onNewSummary: () => void;
  onCopied: (ok: boolean) => void;
}): ReactElement {
  const [viewMode, setViewMode] = useState<"rendered" | "raw">("rendered");
  const generating = generation?.stage === "running";

  return (
    <div className="space-y-5">
      {generation?.stage === "error" && (
        <div role="alert" className="rounded-box bg-error/10 px-4 py-3 text-sm">
          <span className="font-medium">The summary couldn't be generated.</span> <span className="text-base-content/70">{generation.error}</span>
        </div>
      )}
      {generating && (
        <div role="status" className="space-y-3 rounded-box border border-base-300 p-5">
          <p className="flex items-center gap-2 text-sm">
            <Spinner className="h-4 w-4 text-primary" />
            <span className="font-medium">Writing a new summary</span>
            <span className="text-base-content/60">
              {generation.model ? `with ${modelNames.get(`${generation.provider}:${generation.model}`) ?? generation.model}` : ""} · this can take a minute
            </span>
          </p>
          <div className="space-y-2.5">
            <div className="skeleton h-4 w-2/5" />
            <div className="skeleton h-3 w-full" />
            <div className="skeleton h-3 w-11/12" />
            <div className="skeleton h-3 w-4/5" />
          </div>
        </div>
      )}

      {activeSummary ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Menu
              ariaLabel="Summary version"
              align="left"
              triggerClassName="btn btn-sm min-h-11 max-w-full gap-2 border-base-300 bg-transparent font-normal lg:min-h-0"
              trigger={
                <>
                  <span className="truncate font-semibold">{summaryDisplay(activeSummary, modelNames).template}</span>
                  <span className="hidden truncate text-base-content/60 sm:inline">{summaryDisplay(activeSummary, modelNames).detail}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                </>
              }
              menuClassName="min-w-[280px]"
              items={summaries.map((s) => {
                const d = summaryDisplay(s, modelNames);
                return {
                  key: s.id,
                  checked: s.id === activeSummary.id,
                  onSelect: () => onSelect(s.id),
                  label: (
                    <span className="block">
                      <span className="flex items-center gap-1.5 font-medium">
                        {d.template}
                        {s.isPrimary && <span className="tag tag-green px-1.5 text-[11px]">Primary</span>}
                      </span>
                      <span className="block text-xs text-base-content/55">{d.detail}</span>
                    </span>
                  )
                };
              })}
            />
            {activeSummary.isPrimary ? (
              <span className="tag tag-green font-medium" title="Shown first and used as this meeting's summary">
                Primary
              </span>
            ) : (
              <button type="button" onClick={() => onSetPrimary(activeSummary.id)} className="btn btn-ghost btn-sm min-h-11 gap-1.5 font-normal lg:min-h-0">
                <Star className="h-3.5 w-3.5" aria-hidden="true" /> Make primary
              </button>
            )}
            {summaries.length > 1 && (
              <span className="hidden text-[13px] text-base-content/50 md:inline">
                {summaries.length - 1} other version{summaries.length > 2 ? "s" : ""}
              </span>
            )}
            <span className="flex-1" />
            <Segmented
              ariaLabel="Summary view"
              size="sm"
              className="w-40"
              value={viewMode}
              onChange={setViewMode}
              options={[
                { value: "rendered", label: "Preview" },
                { value: "raw", label: "Raw" }
              ]}
            />
            <Menu
              ariaLabel="Summary actions"
              triggerClassName="btn btn-ghost btn-square btn-sm min-h-11 min-w-11 lg:min-h-0 lg:min-w-0"
              trigger={<Ellipsis className="h-4 w-4" aria-hidden="true" />}
              items={[
                {
                  key: "copy",
                  icon: <ClipboardCopy className="h-4 w-4" aria-hidden="true" />,
                  label: "Copy markdown",
                  onSelect: () => void copySummary(activeSummary.content).then(onCopied)
                },
                {
                  key: "download",
                  icon: <Download className="h-4 w-4" aria-hidden="true" />,
                  label: "Download .md",
                  onSelect: () => downloadSummary(meetingTitle, activeSummary)
                },
                "divider",
                {
                  key: "delete",
                  icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
                  label: "Delete this version…",
                  danger: true,
                  onSelect: () => onDelete(activeSummary.id)
                }
              ]}
            />
          </div>

          <p className="sr-only">Generated {formatDate(activeSummary.createdAt)}</p>
          {viewMode === "rendered" ? (
            <SummaryMarkdown content={activeSummary.content} />
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-box bg-base-200 p-4 font-mono text-xs leading-relaxed">{activeSummary.content}</pre>
          )}
        </div>
      ) : !generating ? (
        <div className="rounded-box border border-dashed border-base-300 px-6 py-10 text-center">
          <p className="font-medium">No summary yet</p>
          <p className="mt-1 text-sm text-base-content/60">Turn the transcript into notes with one of your templates.</p>
          <button type="button" onClick={onNewSummary} disabled={!canGenerate} className="btn btn-primary btn-sm mt-4 min-h-11 lg:min-h-0">
            New summary
          </button>
        </div>
      ) : null}
    </div>
  );
}
