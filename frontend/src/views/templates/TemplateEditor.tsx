import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement, ReactNode } from "react";
import { Copy, Eye, EyeOff, Lock, Trash2 } from "lucide-react";
import type { Template } from "../../api/types.ts";
import { ActionMenu } from "../people/ActionMenu";
import { TemplatePreview } from "./TemplatePreview";

/* Variables substituted by backend/src/olive/services/summaries.py. */
export const TEMPLATE_VARIABLES = ["{{title}}", "{{date}}", "{{speakers}}", "{{language}}", "{{transcript}}"] as const;

export const NEW_TEMPLATE_PROMPT = `# Meeting Summary: {{title}}\n**Date:** {{date}}\n**Participants:** {{speakers}}\n\n## Summary\n\n## Action Items\n- [ ] \n\n---\n### Transcript\n{{transcript}}`;

export interface TemplateDraft {
  name: string;
  description: string;
  systemPrompt: string;
  userPrompt: string;
  isDefault: boolean;
}

export function draftFrom(template: Template | null, clone: Template | null): TemplateDraft {
  if (template && !clone) {
    return {
      name: template.name,
      description: template.description || "",
      systemPrompt: template.systemPrompt,
      userPrompt: template.userPrompt,
      isDefault: template.isDefault,
    };
  }
  if (clone) {
    return {
      name: `${clone.name} (Custom)`,
      description: clone.description || "",
      systemPrompt: clone.systemPrompt,
      userPrompt: clone.userPrompt,
      isDefault: false,
    };
  }
  return { name: "", description: "", systemPrompt: "", userPrompt: NEW_TEMPLATE_PROMPT, isDefault: false };
}

export function sameDraft(a: TemplateDraft, b: TemplateDraft): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.systemPrompt === b.systemPrompt &&
    a.userPrompt === b.userPrompt &&
    a.isDefault === b.isDefault
  );
}

/* Saves the draft: PATCH for an existing custom template, POST otherwise.
   Returns the saved template. */
export async function saveTemplateDraft(draft: TemplateDraft, existingId: string | null): Promise<Template> {
  if (!draft.name.trim()) throw new Error("Template name is required");
  if (!draft.userPrompt.trim()) throw new Error("Prompt is required");
  const res = await fetch(existingId ? `/api/templates/${existingId}` : "/api/templates", {
    method: existingId ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      systemPrompt: draft.systemPrompt.trim(),
      userPrompt: draft.userPrompt.trim(),
      isDefault: draft.isDefault,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { template?: Template; error?: string };
  if (!res.ok || !data.template) throw new Error(data.error || `HTTP ${res.status}`);
  return data.template;
}

/* Full-page template editor. Built-in templates open read-only and can be
   duplicated; custom ones are edited in place. */
export function TemplateEditor({
  template,
  initialClone,
  draft,
  onDraftChange,
  saving,
  error,
  dirty,
  onSave,
  onCancel,
  onSetDefault,
  onDuplicate,
  onDelete,
  headerExtra,
}: {
  template: Template | null;
  initialClone: Template | null;
  draft: TemplateDraft;
  onDraftChange: (draft: TemplateDraft) => void;
  saving: boolean;
  error: string | null;
  dirty: boolean;
  onSave: () => void;
  onCancel?: () => void;
  onSetDefault?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  headerExtra?: ReactNode;
}): ReactElement {
  const isNew = !template || Boolean(initialClone);
  const readOnly = Boolean(template && !initialClone && template.isBuiltin);
  const [showPreview, setShowPreview] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isNew) nameRef.current?.focus();
  }, [isNew]);

  const set = (patch: Partial<TemplateDraft>) => onDraftChange({ ...draft, ...patch });

  const insertVariable = (tag: string) => {
    const textarea = promptRef.current;
    if (!textarea) {
      set({ userPrompt: `${draft.userPrompt} ${tag}` });
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    set({ userPrompt: draft.userPrompt.substring(0, start) + tag + draft.userPrompt.substring(end) });
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + tag.length, start + tag.length);
    }, 0);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!readOnly) onSave();
  };

  const status = isNew
    ? initialClone
      ? `New template · from ${initialClone.name}`
      : "New template"
    : template!.isBuiltin
      ? "Built-in template"
      : `Custom template · edited ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(template!.updatedAt))}`;

  const menuItems = [
    onDuplicate && {
      label: "Duplicate",
      icon: <Copy className="h-4 w-4" aria-hidden="true" />,
      onSelect: onDuplicate,
    },
    onDelete && "divider",
    onDelete && {
      label: "Delete…",
      icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
      danger: true,
      onSelect: onDelete,
    },
  ].filter(Boolean) as Parameters<typeof ActionMenu>[0]["items"];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-5" aria-label="Template editor">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm text-base-content/60">
            {headerExtra}
            {readOnly && <Lock className="h-3.5 w-3.5" aria-hidden="true" />}
            {status}
            {template?.isDefault && !isNew && <span className="tag tag-green">Default</span>}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowPreview((v) => !v)}
              aria-pressed={showPreview}
              className="btn btn-sm min-h-11 gap-1.5 border-base-300 bg-transparent font-normal shadow-none hover:bg-hover lg:min-h-8"
            >
              {showPreview ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
              Preview
            </button>
            {onSetDefault && !isNew && !template!.isDefault && (
              <button
                type="button"
                onClick={onSetDefault}
                className="btn btn-sm min-h-11 border-base-300 bg-transparent font-normal shadow-none hover:bg-hover lg:min-h-8"
              >
                Make default
              </button>
            )}
            {readOnly ? (
              onDuplicate && (
                <button type="button" onClick={onDuplicate} className="btn btn-primary btn-sm min-h-11 lg:min-h-8">
                  Duplicate to edit
                </button>
              )
            ) : (
              <>
                {onCancel && (
                  <button type="button" onClick={onCancel} disabled={saving} className="btn btn-ghost btn-sm min-h-11 font-normal lg:min-h-8">
                    Cancel
                  </button>
                )}
                <button type="submit" disabled={saving || (!isNew && !dirty)} className="btn btn-primary btn-sm min-h-11 lg:min-h-8">
                  {saving ? "Saving…" : isNew ? "Create template" : "Save"}
                </button>
              </>
            )}
            {menuItems.length > 0 && <ActionMenu label="Template actions" items={menuItems} buttonClassName="border border-base-300" />}
          </div>
        </div>

        {readOnly && (
          <p className="rounded-lg bg-base-200 px-3 py-2 text-sm text-base-content/70">
            Built-in templates can't be changed. Duplicate this one to make your own version.
          </p>
        )}

        <div className="flex flex-col gap-1">
          <input
            ref={nameRef}
            type="text"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            readOnly={readOnly}
            required
            placeholder="Untitled template"
            aria-label="Template name"
            className="w-full min-w-0 bg-transparent p-0 text-2xl font-bold tracking-tight outline-none placeholder:text-base-content/30 sm:text-[32px] sm:leading-tight"
          />
          <input
            type="text"
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
            readOnly={readOnly}
            placeholder={readOnly ? "" : "Add a description"}
            aria-label="Description"
            className="w-full min-w-0 bg-transparent p-0 text-[15px] text-base-content/70 outline-none placeholder:text-base-content/30"
          />
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-base-content/70">
            Instructions for the model <span className="font-normal">· optional</span>
          </span>
          <textarea
            rows={3}
            value={draft.systemPrompt}
            onChange={(e) => set({ systemPrompt: e.target.value })}
            readOnly={readOnly}
            placeholder="e.g. You are an agile coach summarizing a team retrospective."
            className="textarea w-full resize-y text-sm"
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="template-prompt" className="text-sm font-medium text-base-content/70">
              Prompt
            </label>
            {!readOnly && (
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-base-content/60">Insert</span>
                {TEMPLATE_VARIABLES.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => insertVariable(tag)}
                    className="inline-flex min-h-11 items-center rounded border border-base-300 px-2 font-mono text-xs hover:bg-hover lg:min-h-6"
                  >
                    {tag}
                  </button>
                ))}
              </span>
            )}
          </div>
          <textarea
            id="template-prompt"
            ref={promptRef}
            rows={16}
            required
            value={draft.userPrompt}
            onChange={(e) => set({ userPrompt: e.target.value })}
            readOnly={readOnly}
            className="textarea w-full resize-y bg-base-200 font-mono text-[13px] leading-relaxed"
          />
          <p className="text-xs text-base-content/60">
            {"{{transcript}}"} is replaced by the full dialogue, {"{{language}}"} by the summary language. Without {"{{language}}"}, Olive asks the model to answer in that language.
          </p>
        </div>

        {isNew && (
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.isDefault}
              onChange={(e) => set({ isDefault: e.target.checked })}
              className="checkbox checkbox-sm checkbox-primary"
            />
            Use as the default summary template
          </label>
        )}

        {error && <div className="alert alert-soft alert-error text-sm">{error}</div>}
      </form>

      {showPreview && (
        <TemplatePreview systemPrompt={draft.systemPrompt} userPrompt={draft.userPrompt} />
      )}
    </div>
  );
}
