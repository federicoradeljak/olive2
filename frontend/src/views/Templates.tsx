import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { ArrowLeft, Plus, Search } from "lucide-react";
import { Modal, confirmAction, notify } from "../components/ui";
import type { Template } from "../api/types.ts";
import { TemplateEditor, draftFrom, sameDraft, saveTemplateDraft } from "./templates/TemplateEditor";
import type { TemplateDraft } from "./templates/TemplateEditor";

type Selection = { kind: "existing"; id: string } | { kind: "new"; clone: Template | null };

const EMPTY_DRAFT: TemplateDraft = draftFrom(null, null);

export function TemplatesListView(): ReactElement {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  // Below lg the list and the editor are separate screens.
  const [mobileEditorOpen, setMobileEditorOpen] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT);
  const [baseline, setBaseline] = useState<TemplateDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchTemplates = async (): Promise<Template[]> => {
    setError(null);
    try {
      const res = await fetch("/api/templates");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: Failed to fetch templates`);
      }
      const data = (await res.json()) as { templates: Template[] };
      setTemplates(data.templates);
      return data.templates;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setLoading(false);
    }
  };

  const openDraft = (next: Selection, list: Template[] = templates) => {
    const template = next.kind === "existing" ? list.find((t) => t.id === next.id) ?? null : null;
    const d = next.kind === "existing" ? draftFrom(template, null) : draftFrom(null, next.clone);
    setSelection(next);
    setDraft(d);
    setBaseline(d);
    setSaveError(null);
  };

  useEffect(() => {
    void fetchTemplates().then((list) => {
      const first = list.find((t) => t.isDefault) ?? list[0];
      if (first) openDraft({ kind: "existing", id: first.id }, list);
    });
  }, []);

  const selected = selection?.kind === "existing" ? templates.find((t) => t.id === selection.id) ?? null : null;
  const isNew = selection?.kind === "new";
  const dirty = !sameDraft(draft, baseline);

  const confirmDiscard = async (): Promise<boolean> => {
    if (!dirty) return true;
    return confirmAction({
      title: "Discard changes?",
      message: `Your unsaved edits to "${draft.name || "this template"}" will be lost.`,
      confirmLabel: "Discard",
      danger: true,
    });
  };

  const select = async (next: Selection) => {
    if (selection?.kind === "existing" && next.kind === "existing" && selection.id === next.id) {
      setMobileEditorOpen(true);
      return;
    }
    if (!(await confirmDiscard())) return;
    openDraft(next);
    setMobileEditorOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Existing templates change default only through "Make default".
      const payload = selected && !isNew ? { ...draft, isDefault: selected.isDefault } : draft;
      const saved = await saveTemplateDraft(payload, selected && !isNew ? selected.id : null);
      const list = await fetchTemplates();
      openDraft({ kind: "existing", id: saved.id }, list);
      notify("success", isNew ? `Created "${saved.name}"` : `Saved "${saved.name}"`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      const res = await fetch(`/api/templates/${id}/default`, { method: "POST" });
      if (!res.ok) {
        throw new Error("Failed to set default template");
      }
      await fetchTemplates();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (template: Template) => {
    if (
      !(await confirmAction({
        title: `Delete "${template.name}"?`,
        message: "The template is removed for good. Summaries already generated with it are kept.",
        confirmLabel: "Delete",
        danger: true,
      }))
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/templates/${template.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to delete template");
      }
      const list = await fetchTemplates();
      const next = list.find((t) => t.isDefault) ?? list[0];
      if (next) openDraft({ kind: "existing", id: next.id }, list);
      else setSelection(null);
      setMobileEditorOpen(false);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  const filteredTemplates = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return templates;
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(query) ||
        (t.description && t.description.toLowerCase().includes(query)) ||
        t.userPrompt.toLowerCase().includes(query),
    );
  }, [templates, search]);

  const backButton = (
    <button
      type="button"
      onClick={() => {
        void confirmDiscard().then((ok) => {
          if (!ok) return;
          if (isNew) {
            const first = templates.find((t) => t.isDefault) ?? templates[0];
            if (first) openDraft({ kind: "existing", id: first.id });
          } else {
            setDraft(baseline);
          }
          setMobileEditorOpen(false);
        });
      }}
      className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm text-base-content/60 hover:bg-hover hover:text-base-content lg:hidden"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Templates
    </button>
  );

  return (
    <div className="grid min-w-0 gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
      <section aria-label="Templates" className={`min-w-0 flex-col gap-3 ${mobileEditorOpen ? "hidden lg:flex" : "flex"}`}>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl lg:text-[22px]">Templates</h1>
          <button
            type="button"
            aria-label="New template"
            title="New template"
            onClick={() => void select({ kind: "new", clone: null })}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-base-content/70 hover:bg-hover hover:text-base-content lg:h-8 lg:w-8"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {templates.length > 5 && (
          <label className="flex h-11 items-center gap-2 rounded-md bg-hover px-2.5 text-base-content/60 focus-within:ring-1 focus-within:ring-primary/40 lg:h-[34px]">
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <input
              type="search"
              placeholder="Filter templates"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Filter templates"
              className="w-full min-w-0 bg-transparent text-base-content outline-none placeholder:text-base-content/50"
            />
          </label>
        )}

        {error && <div className="alert alert-soft alert-error text-sm">{error}</div>}

        {loading ? (
          <div className="py-6 text-sm text-base-content/50">Loading templates…</div>
        ) : (
          <ul className="-mx-2 flex flex-col gap-0.5">
            {isNew && (
              <li>
                <div className="flex flex-col gap-0.5 rounded-lg bg-active px-2.5 py-2">
                  <span className="truncate font-medium">{draft.name.trim() || "Untitled template"}</span>
                  <span className="text-xs text-base-content/60">Unsaved</span>
                </div>
              </li>
            )}
            {filteredTemplates.length === 0 && !isNew && <li className="px-2 py-6 text-sm text-base-content/50">No templates found.</li>}
            {filteredTemplates.map((t) => {
              const active = !isNew && selection?.kind === "existing" && selection.id === t.id;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => void select({ kind: "existing", id: t.id })}
                    aria-current={active ? "true" : undefined}
                    className={`flex min-h-11 w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-hover ${active ? "lg:bg-active" : ""}`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5 font-medium">
                      <span className="truncate">{t.name}</span>
                      {t.isDefault && <span className="tag tag-green shrink-0 !min-h-0 !text-[11px] font-semibold">Default</span>}
                    </span>
                    <span className="line-clamp-1 text-xs text-base-content/60">
                      {t.isBuiltin ? "Built-in" : "Custom"}
                      {t.description ? ` · ${t.description}` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className={`min-w-0 ${mobileEditorOpen ? "block" : "hidden lg:block"}`}>
        {selection && (isNew || selected) ? (
          <div className="flex flex-col gap-2">
            {backButton}
            <TemplateEditor
              key={isNew ? "new" : selected!.id}
              template={isNew ? (selection.kind === "new" ? selection.clone : null) : selected}
              initialClone={isNew && selection.kind === "new" ? selection.clone : null}
              draft={draft}
              onDraftChange={setDraft}
              saving={saving}
              error={saveError}
              dirty={dirty}
              onSave={() => void handleSave()}
              onCancel={
                isNew
                  ? () => {
                      const first = templates.find((t) => t.isDefault) ?? templates[0];
                      if (first) openDraft({ kind: "existing", id: first.id });
                      else setSelection(null);
                      setMobileEditorOpen(false);
                    }
                  : dirty
                    ? () => setDraft(baseline)
                    : undefined
              }
              onSetDefault={selected && !isNew ? () => void handleSetDefault(selected.id) : undefined}
              onDuplicate={selected && !isNew ? () => void select({ kind: "new", clone: selected }) : undefined}
              onDelete={selected && !isNew && !selected.isBuiltin ? () => void handleDelete(selected) : undefined}
            />
          </div>
        ) : (
          !loading && (
            <div className="rounded-xl border border-dashed border-base-300 px-6 py-16 text-center text-sm text-base-content/60">
              Pick a template, or create a new one.
            </div>
          )
        )}
      </div>
    </div>
  );
}

/* Kept for callers that still open the editor as a dialog; the Templates
   screen itself edits in place. */
export function TemplateEditorModal({
  template,
  initialClone,
  onClose,
  onSaved
}: {
  template: Template | null;
  initialClone: Template | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const isEditing = Boolean(template && !initialClone);
  const [draft, setDraft] = useState<TemplateDraft>(() => draftFrom(template, initialClone));
  const [baseline] = useState<TemplateDraft>(draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveTemplateDraft(draft, isEditing ? template!.id : null);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={isEditing ? "Edit template" : initialClone ? `Customize "${initialClone.name}"` : "New template"}
      ariaLabel="Summary template editor"
      maxWidth="max-w-3xl"
    >
      <TemplateEditor
        template={isEditing ? template : initialClone}
        initialClone={isEditing ? null : initialClone}
        draft={draft}
        onDraftChange={setDraft}
        saving={saving}
        error={error}
        dirty={!sameDraft(draft, baseline)}
        onSave={() => void handleSave()}
        onCancel={onClose}
      />
    </Modal>
  );
}
