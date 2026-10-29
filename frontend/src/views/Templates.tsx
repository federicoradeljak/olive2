import React, { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Save } from "lucide-react";
import { confirmAction, notify } from "../components/ui";
import type { Template } from "../api/types.ts";
import { Modal } from "./AppModals";

export function TemplatesListView(): ReactElement {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [cloningTemplate, setCloningTemplate] = useState<Template | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const fetchTemplates = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/templates");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: Failed to fetch templates`);
      }
      const data = (await res.json()) as { templates: Template[] };
      setTemplates(data.templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchTemplates();
  }, []);

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

  const handleDelete = async (id: string, name: string) => {
    if (!(await confirmAction({ title: "Delete template", message: `Are you sure you want to delete template "${name}"?`, confirmLabel: "Delete", danger: true }))) {
      return;
    }
    try {
      const res = await fetch(`/api/templates/${id}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error("Failed to delete template");
      }
      await fetchTemplates();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    }
  };

  const filteredTemplates = templates.filter((t) => {
    if (!search.trim()) return true;
    const query = search.toLowerCase();
    return (
      t.name.toLowerCase().includes(query) ||
      (t.description && t.description.toLowerCase().includes(query)) ||
      t.userPrompt.toLowerCase().includes(query)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Summary Templates</h1>
          <p className="text-sm text-base-content/70">
            Customizable prompt templates for generating structured meeting summaries & action items
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditingTemplate(null);
            setCloningTemplate(null);
            setIsCreating(true);
          }}
          className="btn btn-primary inline-flex min-h-[44px] items-center justify-center gap-2 sm:min-h-0"
        >
          <span>+</span>
          <span>New Template</span>
        </button>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Filter templates…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input input-md w-full max-w-sm bg-base-200/80 px-3.5"
        />
      </div>

      {error && (
        <div className="alert alert-soft alert-error p-4 text-sm text-error">
          {error}
        </div>
      )}

      {loading ? (
        <div className="p-12 text-center text-sm text-base-content/50">Loading templates…</div>
      ) : filteredTemplates.length === 0 ? (
        <div className="rounded-xl border border-base-300 bg-base-200/30 p-12 text-center text-sm text-base-content/50">
          No templates found.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {filteredTemplates.map((t) => (
            <div
              key={t.id}
              className={`flex flex-col justify-between rounded-xl border p-5 transition ${
                t.isDefault
                  ? "border-primary/40 bg-base-200/80 ring-1 ring-primary/20"
                  : "border-base-300 bg-base-200/50 hover:border-base-300"
              }`}
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-base-content">{t.name}</h3>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {t.isDefault && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary border border-primary/20">
                        Default
                      </span>
                    )}
                    {t.isBuiltin ? (
                      <span className="rounded-full bg-base-300 px-2 py-0.5 text-[11px] font-medium text-base-content/70">
                        Built-in
                      </span>
                    ) : (
                      <span className="badge badge-sm badge-accent badge-soft font-medium">
                        Custom
                      </span>
                    )}
                  </div>
                </div>

                {t.description && (
                  <p className="text-xs text-base-content/70 leading-relaxed">{t.description}</p>
                )}

                {t.systemPrompt && (
                  <div className="space-y-1">
                    <span className="text-[10px] font-medium tracking-wider uppercase text-base-content/50">
                      System Instructions
                    </span>
                    <p className="text-xs text-base-content bg-base-100/60 rounded p-2 border border-base-300/80 line-clamp-2">
                      {t.systemPrompt}
                    </p>
                  </div>
                )}

                <div className="space-y-1">
                  <span className="text-[10px] font-medium tracking-wider uppercase text-base-content/50">
                    Prompt Template
                  </span>
                  <pre className="max-h-48 overflow-y-auto rounded-lg border border-base-300/80 bg-base-100/80 p-3 font-mono text-[11px] text-base-content whitespace-pre-wrap leading-relaxed">
                    {t.userPrompt}
                  </pre>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-base-300/80 pt-3 text-xs">
                <div>
                  {!t.isDefault && (
                    <button
                      type="button"
                      onClick={() => void handleSetDefault(t.id)}
                      className="btn btn-primary btn-soft min-h-[44px] border border-primary/30 sm:min-h-[36px] sm:text-xs"
                    >
                      Make Default
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {t.isBuiltin ? (
                    <button
                      type="button"
                      onClick={() => {
                        setCloningTemplate(t);
                        setEditingTemplate(null);
                        setIsCreating(true);
                      }}
                      className="btn min-h-[44px] sm:min-h-[36px] sm:text-xs"
                    >
                      Duplicate & Edit
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingTemplate(t);
                          setCloningTemplate(null);
                          setIsCreating(true);
                        }}
                        className="btn min-h-[44px] sm:min-h-[36px] sm:text-xs"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(t.id, t.name)}
                        className="btn min-h-[44px] hover:border-error/50 hover:text-error sm:min-h-[36px] sm:text-xs"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {isCreating && (
        <TemplateEditorModal
          template={editingTemplate}
          initialClone={cloningTemplate}
          onClose={() => {
            setIsCreating(false);
            setEditingTemplate(null);
            setCloningTemplate(null);
          }}
          onSaved={() => {
            setIsCreating(false);
            setEditingTemplate(null);
            setCloningTemplate(null);
            void fetchTemplates();
          }}
        />
      )}
    </div>
  );
}

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
  const [name, setName] = useState(
    template ? template.name : initialClone ? `${initialClone.name} (Custom)` : ""
  );
  const [description, setDescription] = useState(
    template ? template.description || "" : initialClone ? initialClone.description || "" : ""
  );
  const [systemPrompt, setSystemPrompt] = useState(
    template ? template.systemPrompt : initialClone ? initialClone.systemPrompt : ""
  );
  const [userPrompt, setUserPrompt] = useState(
    template
      ? template.userPrompt
      : initialClone
      ? initialClone.userPrompt
      : `# Meeting Summary: {{title}}\n**Date:** {{date}}\n**Participants:** {{speakers}}\n\n## Summary\n\n## Action Items\n- [ ] \n\n---\n### Transcript\n{{transcript}}`
  );
  const [isDefault, setIsDefault] = useState(template ? template.isDefault : false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);

  const insertVariable = (tag: string) => {
    const textarea = promptTextareaRef.current;
    if (!textarea) {
      setUserPrompt((prev) => `${prev} ${tag}`);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const nextVal = userPrompt.substring(0, start) + tag + userPrompt.substring(end);
    setUserPrompt(nextVal);
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + tag.length, start + tag.length);
    }, 0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Template name is required");
      return;
    }
    if (!userPrompt.trim()) {
      setError("User prompt template is required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const url = isEditing ? `/api/templates/${template!.id}` : "/api/templates";
      const method = isEditing ? "PATCH" : "POST";
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        systemPrompt: systemPrompt.trim(),
        userPrompt: userPrompt.trim(),
        isDefault
      };

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title={isEditing ? "Edit Template" : initialClone ? `Customize "${initialClone.name}"` : "New Summary Template"} ariaLabel="Summary template editor" maxWidth="max-w-2xl">
      {error && (
        <div className="alert alert-soft alert-error p-3 text-xs text-error">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1">
          <label className="text-xs font-medium uppercase tracking-wider text-base-content/70">
            Template Name *
          </label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sprint Retrospective"
            className="input input-md w-full"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium uppercase tracking-wider text-base-content/70">
            Description
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Highlights wins, blockers, and next sprint commitments"
            className="input input-md w-full"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium uppercase tracking-wider text-base-content/70">
            System Instructions (Optional)
          </label>
          <textarea
            rows={2}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="e.g. You are an expert agile coach summarizing a team retrospective."
            className="textarea w-full textarea-md font-mono"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium uppercase tracking-wider text-base-content/70">
              User Prompt Template *
            </label>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-base-content/50 mr-1">Insert tags:</span>
              {["{{title}}", "{{date}}", "{{speakers}}", "{{language}}", "{{transcript}}"].map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => insertVariable(tag)}
                  className="rounded bg-base-300 px-1.5 py-0.5 text-[11px] font-mono text-primary hover:bg-base-300 transition"
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
          <textarea
            ref={promptTextareaRef}
            rows={9}
            required
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            className="textarea w-full textarea-md font-mono"
          />
        </div>

        <div className="flex items-center gap-2 pt-1">
          <input
            type="checkbox"
            id="isDefaultCheckbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="checkbox checkbox-primary"
          />
          <label htmlFor="isDefaultCheckbox" className="text-xs text-base-content cursor-pointer">
            Set as default summary template
          </label>
        </div>

        <div className="flex justify-end gap-3 border-t border-base-300 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="btn btn-sm min-h-11"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="btn btn-primary btn-sm inline-flex items-center gap-2 min-h-11"
          >
            {saving ? "Saving…" : isEditing ? "Save Changes" : "Create Template"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
