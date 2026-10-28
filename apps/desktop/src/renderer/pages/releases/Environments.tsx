import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useCreateEnvironment,
  useDeleteEnvironment,
  useUpdateEnvironment,
} from "../../data/queries";
import type { EnvironmentInput, ReleaseView } from "../../data/releases";
import type { ProjectEnvironment } from "../../data/types";
import { sameCommit } from "../../domain/releases/releaseStatus";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { Menu, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { MoreGlyph } from "../preferences/glyphs";
import { dangerSolidButton, primaryButton, secondaryButton } from "../tasks/controls";
import { ago, shortSha } from "./format";
import { ExternalGlyph } from "./glyphs";

// Gli ambienti del progetto (shape releases.md §6, «Environments»): pura
// anagrafica, mai un bersaglio che Stubwise esegue. Una riga da 44px: nome ·
// tipo in parola · URL ↗ · server · «runs abc1234 · = AUD-V2 · 10 min ago»
// ([R 11]). Con `environments.manage`: «Add environment» e, per riga, Edit ·
// Delete. Un solo ambiente di tipo Production per progetto ([R 12]).

const KINDS: ProjectEnvironment["kind"][] = ["test", "staging", "production"];

function EnvironmentDialog({
  projectId,
  environment,
  environments,
  onClose,
}: {
  projectId: string;
  environment: ProjectEnvironment | null;
  environments: ProjectEnvironment[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const create = useCreateEnvironment();
  const update = useUpdateEnvironment();
  const ids = { name: useId(), url: useId(), server: useId() };
  const [draft, setDraft] = useState<EnvironmentInput>({
    name: environment?.name ?? "",
    kind: environment?.kind ?? "staging",
    url: environment?.url ?? "",
    serverCode: environment?.serverCode ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const otherProduction = environments.find(
    (e) => e.kind === "production" && e.id !== environment?.id,
  );
  const saving = create.isPending || update.isPending;

  const save = async () => {
    setError(null);
    const input: EnvironmentInput = {
      name: draft.name,
      kind: draft.kind,
      url: draft.url?.trim() || null,
      serverCode: draft.serverCode?.trim().toUpperCase() || null,
    };
    try {
      if (environment) await update.mutateAsync({ id: environment.id, patch: input });
      else await create.mutateAsync({ projectId, input });
      onClose();
    } catch (e) {
      const code = e instanceof Error ? e.message.replace(/^invalid: /, "") : "";
      setError(
        t(`releases.environments.errors.${code}`, {
          defaultValue: t("releases.environments.errors.generic"),
        }),
      );
    }
  };

  return (
    <Dialog
      title={
        environment ? t("releases.environments.editTitle") : t("releases.environments.addTitle")
      }
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("releases.cancel")}
          </button>
          <button
            type="button"
            disabled={saving || !draft.name.trim()}
            onClick={() => void save()}
            className={`${primaryButton} disabled:opacity-40`}
          >
            {environment ? t("releases.environments.save") : t("releases.environments.add")}
          </button>
        </>
      }
    >
      <DialogField label={t("releases.environments.name")} htmlFor={ids.name}>
        <input
          id={ids.name}
          data-autofocus
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          className={inputClass}
        />
      </DialogField>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="pb-1.5 text-sm font-medium text-ink">
          {t("releases.environments.kind")}
        </legend>
        {KINDS.map((kind) => {
          const blocked = kind === "production" && !!otherProduction;
          return (
            <label
              key={kind}
              className={`flex items-center gap-2 text-md ${blocked ? "text-ink-faint" : "text-ink"}`}
            >
              <input
                type="radio"
                name="environment-kind"
                checked={draft.kind === kind}
                disabled={blocked}
                onChange={() => setDraft((d) => ({ ...d, kind }))}
                className="accent-ink"
              />
              {t(`releases.environments.kinds.${kind}`)}
            </label>
          );
        })}
        {otherProduction && (
          <p className="text-xs text-ink-muted">
            {t("releases.environments.productionExists", { name: otherProduction.name })}
          </p>
        )}
      </fieldset>
      <DialogField label={t("releases.environments.url")} htmlFor={ids.url}>
        <input
          id={ids.url}
          type="url"
          placeholder="https://"
          value={draft.url ?? ""}
          onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
          className={inputClass}
        />
      </DialogField>
      <DialogField
        label={t("releases.environments.server")}
        htmlFor={ids.server}
        hint={t("releases.environments.serverHint")}
      >
        <input
          id={ids.server}
          placeholder="SRV-3"
          value={draft.serverCode ?? ""}
          onChange={(e) => setDraft((d) => ({ ...d, serverCode: e.target.value }))}
          className={`${inputClass} num`}
        />
      </DialogField>
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function DeleteDialog({
  environment,
  onClose,
}: {
  environment: ProjectEnvironment;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const remove = useDeleteEnvironment();
  const toast = useToast();
  return (
    <Dialog
      title={t("releases.environments.deleteTitle", { name: environment.name })}
      description={
        environment.kind === "production" ? t("releases.environments.deleteProduction") : undefined
      }
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose} data-autofocus>
            {t("releases.cancel")}
          </button>
          <button
            type="button"
            disabled={remove.isPending}
            className={dangerSolidButton}
            onClick={() =>
              remove.mutate(environment.id, {
                onSuccess: onClose,
                onError: () =>
                  toast.error(t("releases.environments.deleteError", { name: environment.name })),
              })
            }
          >
            {t("releases.environments.delete")}
          </button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}

function RowMenu({
  environment,
  onEdit,
  onDelete,
}: {
  environment: ProjectEnvironment;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("releases.environments.more", { name: environment.name })}
        onClick={() => setOpen((v) => !v)}
        className="grid size-7 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
      >
        <MoreGlyph />
      </button>
      {open && (
        <Menu label={environment.name} align="right" onClose={() => setOpen(false)}>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={itemClass}
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          >
            {t("releases.environments.edit")}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`${itemClass} text-critical`}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            {t("releases.environments.delete")}
          </button>
        </Menu>
      )}
    </span>
  );
}

export function Environments({
  projectId,
  projectCode,
  canManage,
  environments,
  releases,
}: {
  projectId: string;
  projectCode: string;
  canManage: boolean;
  environments: ProjectEnvironment[];
  releases: ReleaseView[];
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState<ProjectEnvironment | "new" | null>(null);
  const [deleting, setDeleting] = useState<ProjectEnvironment | null>(null);
  const runsLine = (e: ProjectEnvironment) => {
    if (!e.reportedSha) return null;
    const release = releases.find((r) => sameCommit(r.mergeSha, e.reportedSha));
    return [
      t("releases.environments.runs", { sha: shortSha(e.reportedSha) }),
      release ? `= ${release.code}` : null,
      e.reportedAt ? ago(e.reportedAt, t, i18n.language) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  return (
    <div className="flex flex-col">
      {environments.length === 0 ? (
        <div className="flex flex-col items-start gap-2 border-t border-rule px-3 py-3">
          <p className="text-md text-ink-muted">
            {canManage
              ? t("releases.environments.emptyManage", { code: projectCode })
              : t("releases.environments.empty")}
          </p>
        </div>
      ) : (
        <ul
          aria-label={t("releases.parts.environments")}
          className="flex flex-col border-t border-rule"
        >
          {environments.map((e) => (
            <li
              key={e.id}
              data-environment={e.name}
              className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-rule px-3 py-1.5"
            >
              <span className="text-md font-medium text-ink">{e.name}</span>
              <span className="text-sm text-ink-muted">
                {t(`releases.environments.kinds.${e.kind}`)}
              </span>
              {e.url && (
                <a
                  href={e.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 truncate rounded-sm text-sm text-ink underline-offset-4 hover:underline"
                >
                  {e.url.replace(/^https?:\/\//, "")}
                  <ExternalGlyph />
                </a>
              )}
              {e.serverCode && (
                <span className="num text-xs font-semibold text-ink">{e.serverCode}</span>
              )}
              <span className="num ml-auto text-sm text-ink-muted">{runsLine(e)}</span>
              {canManage && (
                <RowMenu
                  environment={e}
                  onEdit={() => setEditing(e)}
                  onDelete={() => setDeleting(e)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <EnvironmentDialog
          projectId={projectId}
          environment={editing === "new" ? null : editing}
          environments={environments}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && <DeleteDialog environment={deleting} onClose={() => setDeleting(null)} />}
      {canManage && <AddEnvironmentAnchor onAdd={() => setEditing("new")} />}
    </div>
  );
}

/** «Add environment» sotto l'elenco (nella testata della parte c'è lo stesso). */
function AddEnvironmentAnchor({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      data-add-environment
      onClick={onAdd}
      className="mt-2 inline-flex h-7 items-center self-start rounded-md px-3 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
    >
      {t("releases.environments.addButton")}
    </button>
  );
}
