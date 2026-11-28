import { useNavigate } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useCreateWorkspace,
  useDeleteWorkspace,
  useProjects,
  useRenameWorkspace,
  useSetProjectWorkspace,
  useWorkspaceEffect,
  useWorkspaces,
  type WorkspaceOperation,
} from "../../../data/queries";
import { can, useViewer } from "../../../data/viewing";
import { useReauth } from "../../../layout/useReauth";
import { Dialog, inputClass } from "../../../tasks-ui/Dialog";
import { useToast } from "../../../tasks-ui/Toast";
import { dangerSolidButton, primaryButton, secondaryButton } from "../../tasks/controls";
import { EffectLine, blocks } from "./EffectLine";

// I dialoghi delle workspace (shape `workspaces.md`, «Creare una workspace e
// metterci i progetti»): New workspace, Add projects…, Rename e Delete…. Ogni
// cambio d'accesso dice prima chi tocca (`EffectLine`) e passa dalla
// riconferma (D11); rinominare no.

type Result = { ok: true; slug?: string } | { ok: false; error: string; reason?: string };

/** Un rifiuto in parole, sotto il dialogo. */
export function useRefusalWords() {
  const { t } = useTranslation();
  return (r: Result): string | null => {
    if (r.ok || r.error === "reauth_cancelled") return null;
    if (r.error === "invalid" && r.reason) {
      const key = `workspaces.refusals.${r.reason}`;
      const words = t(key);
      if (words !== key) return words;
    }
    if (r.error === "escalation") return t("workspaces.refusals.escalationAny");
    if (r.error === "forbidden") return t("workspaces.refusals.forbidden");
    return t("workspaces.refusals.generic");
  };
}

/**
 * La scelta dei progetti: i progetti aperti che chi guarda vede. Uno già in
 * un'altra workspace dice «in Interni — moves here»; uno di cui chi agisce non
 * gestisce i membri è spento col motivo (D4).
 */
function ProjectChoices({
  workspaceId,
  chosen,
  onChange,
}: {
  workspaceId: string | null;
  chosen: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const projects = useProjects().data ?? [];
  const list = useWorkspaces().data;
  const nameOf = (id: string) => list?.workspaces.find((w) => w.id === id)?.name ?? "";
  const rows = [...projects]
    .filter((p) => list?.workspaceOfProject[p.id] !== workspaceId || workspaceId === null)
    .sort((a, b) => a.code.localeCompare(b.code));
  const legendId = useId();
  return (
    <fieldset aria-labelledby={legendId} className="flex min-h-0 flex-col gap-1">
      <legend id={legendId} className="mb-1 text-sm font-semibold text-ink">
        {t("workspaces.dialog.projects")}
      </legend>
      <ul className="max-h-64 overflow-y-auto rounded-md border border-rule">
        {rows.map((p) => {
          const managed = can(viewer, "project.members.manage", p.id);
          const elsewhere = list?.workspaceOfProject[p.id];
          return (
            <li key={p.id} className="border-b border-rule last:border-b-0">
              <label
                className={`flex items-start gap-2 px-3 py-2 text-sm ${managed ? "" : "text-ink-faint"}`}
              >
                <input
                  type="checkbox"
                  disabled={!managed}
                  checked={chosen.has(p.id)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(p.id);
                    else next.delete(p.id);
                    onChange(next);
                  }}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="num font-semibold">{p.code}</span> {p.name}
                  {elsewhere && (
                    <span className="block text-xs text-ink-muted">
                      {t("workspaces.dialog.movesHere", { name: nameOf(elsewhere) })}
                    </span>
                  )}
                  {!managed && (
                    <span className="block text-xs">
                      {t("workspaces.refusals.notManaged", { code: p.code })}
                    </span>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/** New workspace: nome e progetti; si può creare vuota. */
export function NewWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const reauth = useReauth();
  const create = useCreateWorkspace();
  const words = useRefusalWords();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const nameId = useId();
  const op = useMemo<WorkspaceOperation | null>(
    () => (chosen.size > 0 ? { kind: "create", projectIds: [...chosen] } : null),
    [chosen],
  );
  const effect = useWorkspaceEffect(op).data;

  async function submit() {
    if (sending || !name.trim() || blocks(effect)) return;
    setSending(true);
    setError(null);
    const r = (await reauth(() => create.mutateAsync([name, [...chosen]]), {
      action: t("workspaces.dialog.reauthCreate", { name: name.trim() }),
    })) as Result;
    setSending(false);
    if (!r.ok) return setError(words(r));
    toast.show(t("workspaces.toast.created", { name: name.trim() }));
    onClose();
    void navigate({ to: "/projects", search: { workspace: r.slug, view: "people" } as never });
  }

  return (
    <Dialog
      title={t("workspaces.new")}
      onClose={onClose}
      width={480}
      footer={(dismiss) => (
        <>
          <button type="button" className={secondaryButton} onClick={dismiss}>
            {t("workspaces.dialog.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={!name.trim() || blocks(effect)}
            aria-busy={sending || undefined}
            onClick={() => void submit()}
          >
            {t("workspaces.dialog.create")}
          </button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-sm font-semibold text-ink">
            {t("workspaces.dialog.name")}
          </label>
          <input
            id={nameId}
            data-autofocus
            className={inputClass}
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <ProjectChoices workspaceId={null} chosen={chosen} onChange={setChosen} />
        <p className="text-xs text-ink-muted">{t("workspaces.dialog.later")}</p>
        <EffectLine effect={effect} />
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Add projects…: i progetti scelti entrano nella workspace, uno per uno, con una riconferma. */
export function AddProjectsDialog({
  workspace,
  onClose,
}: {
  workspace: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const set = useSetProjectWorkspace();
  const words = useRefusalWords();
  const projects = useProjects().data ?? [];
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const op = useMemo<WorkspaceOperation | null>(
    () =>
      chosen.size > 0 ? { kind: "addProjects", workspaceId: workspace.id, projectIds: [...chosen] } : null,
    [chosen, workspace.id],
  );
  const effect = useWorkspaceEffect(op).data;

  async function submit() {
    if (sending || chosen.size === 0 || blocks(effect)) return;
    setSending(true);
    setError(null);
    for (const projectId of chosen) {
      const r = (await reauth(() => set.mutateAsync([projectId, workspace.id]), {
        action: t("workspaces.dialog.reauthAdd", { name: workspace.name }),
      })) as Result;
      if (!r.ok) {
        setSending(false);
        return setError(words(r));
      }
    }
    setSending(false);
    const codes = projects.filter((p) => chosen.has(p.id)).map((p) => p.code);
    toast.show(t("workspaces.toast.added", { codes: codes.join(", "), name: workspace.name, count: codes.length }));
    onClose();
  }

  return (
    <Dialog
      title={t("workspaces.dialog.addTitle", { name: workspace.name })}
      onClose={onClose}
      width={480}
      footer={(dismiss) => (
        <>
          <button type="button" className={secondaryButton} onClick={dismiss}>
            {t("workspaces.dialog.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={chosen.size === 0 || blocks(effect)}
            aria-busy={sending || undefined}
            onClick={() => void submit()}
          >
            {t("workspaces.dialog.add")}
          </button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <ProjectChoices workspaceId={workspace.id} chosen={chosen} onChange={setChosen} />
        <EffectLine effect={effect} />
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Rename: nessun accesso cambia, niente riconferma. */
export function RenameWorkspaceDialog({
  workspace,
  onClose,
}: {
  workspace: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const rename = useRenameWorkspace();
  const words = useRefusalWords();
  const [name, setName] = useState(workspace.name);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

  async function submit() {
    const r = (await rename.mutateAsync([workspace.id, name])) as Result;
    if (!r.ok) return setError(words(r));
    onClose();
    void navigate({ to: "/projects", search: { workspace: r.slug } as never, replace: true });
  }

  return (
    <Dialog
      title={t("workspaces.dialog.renameTitle")}
      onClose={onClose}
      width={440}
      footer={(dismiss) => (
        <>
          <button type="button" className={secondaryButton} onClick={dismiss}>
            {t("workspaces.dialog.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={!name.trim()}
            onClick={() => void submit()}
          >
            {t("workspaces.dialog.save")}
          </button>
        </>
      )}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-sm font-semibold text-ink">
          {t("workspaces.dialog.name")}
        </label>
        <input
          id={nameId}
          data-autofocus
          className={inputClass}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Delete…: i progetti restano, in «No workspace»; dice chi smette di vederli. */
export function DeleteWorkspaceDialog({
  workspace,
  onClose,
}: {
  workspace: { id: string; name: string; projectCount: number };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const reauth = useReauth();
  const remove = useDeleteWorkspace();
  const words = useRefusalWords();
  const [error, setError] = useState<string | null>(null);
  const op = useMemo<WorkspaceOperation>(() => ({ kind: "delete", workspaceId: workspace.id }), [workspace.id]);
  const effect = useWorkspaceEffect(op).data;
  const losing = new Set(effect?.projects.flatMap((p) => p.stopSeeing.map((x) => x.personId)) ?? []);

  async function submit() {
    const r = (await reauth(() => remove.mutateAsync([workspace.id]), {
      action: t("workspaces.dialog.reauthDelete", { name: workspace.name }),
      cancelMessage: t("workspaces.dialog.nothingDeleted"),
    })) as Result;
    if (!r.ok) return setError(words(r));
    toast.show(t("workspaces.toast.deleted"));
    onClose();
    void navigate({ to: "/projects", search: {} as never });
  }

  return (
    <Dialog
      title={t("workspaces.dialog.deleteTitle", { name: workspace.name })}
      onClose={onClose}
      width={440}
      footer={(dismiss) => (
        <>
          <button type="button" data-autofocus className={secondaryButton} onClick={dismiss}>
            {t("workspaces.dialog.cancel")}
          </button>
          <button
            type="button"
            className={dangerSolidButton}
            disabled={!effect || blocks(effect)}
            onClick={() => void submit()}
          >
            {t("workspaces.dialog.delete")}
          </button>
        </>
      )}
    >
      <div className="flex flex-col gap-2 text-md">
        <p>
          {t("workspaces.dialog.deleteBody", { count: workspace.projectCount })}{" "}
          {losing.size > 0 && t("workspaces.dialog.deleteLosing", { count: losing.size })}
        </p>
        {effect && blocks(effect) && <EffectLine effect={effect} />}
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
