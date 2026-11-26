import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { isAppBuild } from "../../data/build";
import { featureIntegrated } from "../../data/integration";
import { ContainersDialog, containersOn } from "./EnvironmentContainers";
import { environmentPatch } from "./environmentPatch";
import {
  useCreateEnvironment,
  useDeleteEnvironment,
  useLinkableServers,
  useUpdateEnvironment,
} from "../../data/queries";
import type { EnvironmentInput, EnvironmentView } from "../../data/releases";
import type { ProjectEnvironment } from "../../data/types";
import { useReauth } from "../../layout/useReauth";
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
//
// R-L2: in un ambiente il server si sceglie per repository. Il campo
// «Server» vale per tutto il progetto; con più repository, ognuna può dire
// il suo (vuoto = quello del progetto). Una riga con un server solo per
// tutto il progetto resta com'era; con server per repository, una riga sotto
// per ognuno, con il suo commit.

const KINDS: ProjectEnvironment["kind"][] = ["test", "staging", "production"];

type Repo = { id: string; name: string };

interface Draft {
  name: string;
  kind: ProjectEnvironment["kind"];
  url: string;
  /** Il server di tutto il progetto. */
  server: string;
  /** Il server di una repository, se diverso. */
  byRepo: Record<string, string>;
}

function draftOf(environment: ProjectEnvironment | null): Draft {
  const servers = environment?.servers ?? [];
  return {
    name: environment?.name ?? "",
    kind: environment?.kind ?? "staging",
    url: environment?.url ?? "",
    server: servers.find((s) => s.repositoryId === null)?.serverCode ?? "",
    byRepo: Object.fromEntries(
      servers.flatMap((s) => (s.repositoryId ? [[s.repositoryId, s.serverCode]] : [])),
    ),
  };
}

function inputOf(draft: Draft): EnvironmentInput {
  const code = (s: string | undefined) => s?.trim().toUpperCase() ?? "";
  return {
    name: draft.name,
    kind: draft.kind,
    url: draft.url.trim() || null,
    servers: [
      ...(code(draft.server) ? [{ repositoryId: null, serverCode: code(draft.server) }] : []),
      ...Object.entries(draft.byRepo).flatMap(([repositoryId, s]) =>
        code(s) ? [{ repositoryId, serverCode: code(s) }] : [],
      ),
    ],
  };
}

/**
 * I server che, dopo la modifica (o la cancellazione) di `environment`, non
 * resterebbero in nessun ambiente: quelli che nessun altro progetto usa
 * (`onlyHere`, dal livello dati) e che nessun altro ambiente del progetto
 * nomina. Un server orfano lo ricollega solo chi gestisce il monitoraggio
 * (R-L7): il dialogo lo dice prima di salvare.
 */
function orphaned(
  environment: ProjectEnvironment | null,
  next: string[],
  environments: ProjectEnvironment[],
  onlyHere: string[],
): string[] {
  if (!environment) return [];
  const elsewhere = new Set(
    environments
      .filter((e) => e.id !== environment.id)
      .flatMap((e) => e.servers.map((s) => s.serverCode)),
  );
  return [...new Set(environment.servers.map((s) => s.serverCode))].filter(
    (c) => onlyHere.includes(c) && !next.includes(c) && !elsewhere.has(c),
  );
}

function OrphanWarning({ codes }: { codes: string[] }) {
  const { t } = useTranslation();
  if (codes.length === 0) return null;
  return (
    <p data-orphan-warning className="text-sm text-ink">
      {t("releases.environments.orphanWarning", { count: codes.length, codes: codes.join(", ") })}
    </p>
  );
}

function EnvironmentDialog({
  projectId,
  environment,
  environments,
  repositories,
  onlyHere,
  onClose,
}: {
  projectId: string;
  environment: ProjectEnvironment | null;
  environments: ProjectEnvironment[];
  repositories: Repo[];
  onlyHere: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const create = useCreateEnvironment();
  const update = useUpdateEnvironment();
  const ids = { name: useId(), url: useId(), server: useId(), servers: useId() };
  // I server si scelgono fra quelli che chi scrive vede (area 8, F4a, S3).
  const linkable = useLinkableServers().data ?? [];
  // Nella build app il tipo di un ambiente esistente non cambia (il server non
  // lo permette: un altro tipo è un ambiente nuovo).
  const kindLocked = environment !== null && isAppBuild();
  const [draft, setDraft] = useState<Draft>(() => draftOf(environment));
  // Server per repository: con più repository, o se l'ambiente ne ha già.
  const perRepo =
    repositories.length > 1 || (environment?.servers ?? []).some((s) => s.repositoryId);
  const [error, setError] = useState<string | null>(null);
  const otherProduction = environments.find(
    (e) => e.kind === "production" && e.id !== environment?.id,
  );
  const saving = create.isPending || update.isPending;

  const save = async () => {
    setError(null);
    const input = inputOf(draft);
    try {
      // Solo ciò che è cambiato (review F4a, I2): i collegamenti solo se cambiano.
      if (environment)
        await update.mutateAsync({
          id: environment.id,
          patch: environmentPatch(inputOf(draftOf(environment)), input),
        });
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
          const blocked =
            (kind === "production" && !!otherProduction) || (kindLocked && kind !== draft.kind);
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
        {kindLocked && (
          <p className="text-xs text-ink-muted">{t("releases.environments.kindLocked")}</p>
        )}
      </fieldset>
      <DialogField label={t("releases.environments.url")} htmlFor={ids.url}>
        <input
          id={ids.url}
          type="url"
          placeholder="https://"
          value={draft.url}
          onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
          className={inputClass}
        />
      </DialogField>
      <DialogField
        label={t("releases.environments.server")}
        htmlFor={ids.server}
        hint={t(
          perRepo ? "releases.environments.serverHintRepos" : "releases.environments.serverHint",
        )}
      >
        <input
          id={ids.server}
          list={ids.servers}
          placeholder="SRV-3"
          value={draft.server}
          onChange={(e) => setDraft((d) => ({ ...d, server: e.target.value }))}
          className={`${inputClass} num`}
        />
      </DialogField>
      {perRepo && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="pb-1.5 text-sm font-medium text-ink">
            {t("releases.environments.byRepository")}
          </legend>
          {repositories.map((r) => (
            <label key={r.id} className="grid grid-cols-[minmax(0,1fr)_10rem] items-center gap-3">
              <span className="truncate text-md text-ink" title={r.name}>
                {r.name}
              </span>
              <input
                list={ids.servers}
                placeholder={draft.server.trim() || t("releases.environments.sameAsProject")}
                value={draft.byRepo[r.id] ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, byRepo: { ...d.byRepo, [r.id]: e.target.value } }))
                }
                className={`${inputClass} num`}
              />
            </label>
          ))}
        </fieldset>
      )}
      <datalist id={ids.servers}>
        {linkable.map((s) => (
          <option key={s.code} value={s.code}>
            {s.name}
          </option>
        ))}
      </datalist>
      <OrphanWarning
        codes={orphaned(
          environment,
          inputOf(draft).servers.map((s) => s.serverCode),
          environments,
          onlyHere,
        )}
      />
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
  environments,
  onlyHere,
  onClose,
}: {
  environment: ProjectEnvironment;
  environments: ProjectEnvironment[];
  onlyHere: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const remove = useDeleteEnvironment();
  const toast = useToast();
  const reauth = useReauth();
  const [busy, setBusy] = useState(false);

  // Area 9, F5: un ambiente con file d'ambiente chiede la riconferma (il
  // livello dati lo dice con `reauth_required`); chiuso il dialogo senza,
  // niente è eliminato e questo resta aperto.
  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await reauth(() => remove.mutateAsync(environment.id), {
        action: t("releases.environments.deleteReauthAction", { name: environment.name }),
        cancelMessage: t("releases.environments.deleteReauthCancelled"),
      });
      if (result.ok) onClose();
    } catch {
      toast.error(t("releases.environments.deleteError", { name: environment.name }));
    }
    setBusy(false);
  }

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
            disabled={busy}
            className={dangerSolidButton}
            onClick={() => void submit()}
          >
            {t("releases.environments.delete")}
          </button>
        </>
      }
    >
      <OrphanWarning codes={orphaned(environment, [], environments, onlyHere)} />
    </Dialog>
  );
}

/** I server di un ambiente, una volta ciascuno, nell'ordine delle righe. */
const serverCodesOf = (environment: ProjectEnvironment): string[] => [
  ...new Set(environment.servers.map((s) => s.serverCode)),
];

function RowMenu({
  environment,
  onEdit,
  onDelete,
  onContainers,
}: {
  environment: ProjectEnvironment;
  onEdit: () => void;
  onDelete: () => void;
  /** I container su un server dell'ambiente (R0-D); assente = la voce non c'è. */
  onContainers?: (code: string) => void;
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
          {onContainers &&
            serverCodesOf(environment).map((code) => (
              <button
                key={code}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={itemClass}
                onClick={() => {
                  setOpen(false);
                  onContainers(code);
                }}
              >
                {t("releases.environments.containers.menu", { code })}
              </button>
            ))}
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
  repositories,
  onlyHere = [],
}: {
  projectId: string;
  projectCode: string;
  canManage: boolean;
  environments: EnvironmentView[];
  repositories: Repo[];
  /** I server che nessun altro progetto usa (`listEnvironments`). */
  onlyHere?: string[];
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState<ProjectEnvironment | "new" | null>(null);
  const [deleting, setDeleting] = useState<ProjectEnvironment | null>(null);
  const [containers, setContainers] = useState<{ env: EnvironmentView; code: string } | null>(null);
  // I container degli ambienti (area 8, F4b, R0-D): nell'app finché non è cablato, spenti.
  const withContainers = featureIntegrated("environment-containers");
  const runsLine = (s: EnvironmentView["servers"][number]) => {
    if (!s.reportedSha) return null;
    // Il rilascio che combacia lo dice il livello dati (R-L2: della stessa
    // repository; la riga di progetto solo per quelle senza riga propria).
    const release = s.releaseCode ?? null;
    return [
      t("releases.environments.runs", { sha: shortSha(s.reportedSha) }),
      release ? `= ${release}` : null,
      s.reportedAt ? ago(s.reportedAt, t, i18n.language) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const repoName = (id: string | null) =>
    id === null
      ? t("releases.environments.allRepositories")
      : (repositories.find((r) => r.id === id)?.name ?? id);
  // Un server solo, per tutto il progetto: nella riga, come prima di R-L2.
  const inline = (e: EnvironmentView) =>
    e.servers.length === 1 && e.servers[0]!.repositoryId === null ? e.servers[0]! : null;

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
              {inline(e) && (
                <span className="num text-xs font-semibold text-ink">{inline(e)!.serverCode}</span>
              )}
              <span className="num ml-auto text-sm text-ink-muted">
                {inline(e) && runsLine(inline(e)!)}
              </span>
              {canManage && (
                <RowMenu
                  environment={e}
                  onEdit={() => setEditing(e)}
                  onDelete={() => setDeleting(e)}
                  onContainers={
                    withContainers ? (code) => setContainers({ env: e, code }) : undefined
                  }
                />
              )}
              {!inline(e) && e.servers.length > 0 && (
                <ul className="flex basis-full flex-col pb-0.5">
                  {e.servers.map((s) => (
                    <li
                      key={s.repositoryId ?? ""}
                      data-environment-server={s.serverCode}
                      className="flex min-w-0 flex-wrap items-baseline gap-x-3"
                    >
                      <span className="num text-xs font-semibold text-ink">{s.serverCode}</span>
                      <span className="min-w-0 truncate text-sm text-ink-muted">
                        {repoName(s.repositoryId)}
                      </span>
                      <span className="num ml-auto text-sm text-ink-muted">{runsLine(s)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {withContainers &&
                serverCodesOf(e).flatMap((code) => {
                  const list = containersOn(e, code);
                  return list.length === 0
                    ? []
                    : [
                        <p
                          key={code}
                          data-environment-containers={code}
                          className="num basis-full text-sm text-ink-muted"
                        >
                          {t("releases.environments.containers.line", {
                            code,
                            list: list.join(", "),
                          })}
                        </p>,
                      ];
                })}
            </li>
          ))}
        </ul>
      )}
      {containers && (
        <ContainersDialog
          environment={containers.env}
          code={containers.code}
          onClose={() => setContainers(null)}
        />
      )}
      {editing && (
        <EnvironmentDialog
          projectId={projectId}
          environment={editing === "new" ? null : editing}
          environments={environments}
          repositories={repositories}
          onlyHere={onlyHere}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <DeleteDialog
          environment={deleting}
          environments={environments}
          onlyHere={onlyHere}
          onClose={() => setDeleting(null)}
        />
      )}
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
