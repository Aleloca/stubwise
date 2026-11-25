import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAccessLog,
  useCredential,
  useProject,
  useProjects,
  useVaultEntry,
} from "../../data/queries";
import type { CredentialView } from "../../data/vault/types";
import { DetailPanel } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { openInWeb } from "../../platform/openWeb";
import { useToast } from "../../tasks-ui/Toast";
import { quietButton } from "../tasks/controls";
import { CredentialForm } from "./CredentialForm";
import { CredentialReaders } from "./CredentialReaders";
import { AccessWord, PasswordField } from "./CredentialRows";
import { usePasswordReveal } from "./usePasswordReveal";

// Il dettaglio di una credenziale (`?credential=<id>`, shape `vault.md` §3):
// il pannello di destra nella sezione Credentials e nella pagina Vault. I
// campi in chiaro, la password come nelle righe (Show/Hide/Copy), le note con
// l'avviso che non sono cifrate, e il registro degli accessi — chi l'ha
// mostrata o copiata, e da dove (VA-Q5) — per chi la gestisce. Un
// `?credential=` che chi guarda non vede chiude il pannello in silenzio.

/** Dove il pannello si apre: la sezione Credentials di un progetto, o la pagina Vault. */
const WHERE = /^\/(?:p\/[^/]+\/credentials|vault)\/?$/;
/** Nella sezione di un progetto, il suo codice (`?credential=new` crea lì). */
const SECTION = /^\/p\/([^/]+)\/credentials\/?$/;

/** Come il pannello delle PR: affiancato già da 1024 px. */
export const CREDENTIAL_PANEL_DOCKED_QUERY = "(min-width: 1024px)";

export function CredentialPanelHost() {
  const search = useSearch({ strict: false }) as { credential?: string; edit?: string };
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (!search.credential || !WHERE.test(pathname)) return null;
  if (search.credential === "new") {
    const code = SECTION.exec(pathname)?.[1];
    return code ? <NewCredentialPanel code={code} /> : <NewCredentialPanelVault />;
  }
  return (
    <CredentialPanelFor
      key={search.credential}
      id={search.credential}
      startEditing={search.edit === "1"}
    />
  );
}

/** Il pannello col modulo di una credenziale nuova, nel progetto della sezione. */
function NewCredentialPanel({ code }: { code: string }) {
  const { t } = useTranslation();
  const docked = useMediaQuery(CREDENTIAL_PANEL_DOCKED_QUERY);
  const project = useProject(code).data;
  const go = useGoToCredential();
  if (!project) return null;
  return (
    <DetailPanel
      mode={docked ? "docked" : "overlay"}
      label={t("vault.form.newTitle")}
      onClose={() => go(undefined)}
    >
      <CredentialForm
        mode={{ kind: "new", projectId: project.id }}
        onSaved={(id) => go(id)}
        onCancel={() => go(undefined)}
      />
    </DetailPanel>
  );
}

/** Dalla pagina Vault: il progetto si sceglie fra quelli dove chi guarda crea. */
function NewCredentialPanelVault() {
  const { t } = useTranslation();
  const docked = useMediaQuery(CREDENTIAL_PANEL_DOCKED_QUERY);
  const entry = useVaultEntry().data;
  const projects = useProjects().data;
  const go = useGoToCredential();
  if (!entry || !projects) return null;
  const choices = entry.createProjectIds
    .map((id) => ({ id, code: projects.find((p) => p.id === id)?.code ?? id }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return (
    <DetailPanel
      mode={docked ? "docked" : "overlay"}
      label={t("vault.form.newTitle")}
      onClose={() => go(undefined)}
    >
      <CredentialForm
        mode={{ kind: "new", projectChoices: choices }}
        onSaved={(id) => go(id)}
        onCancel={() => go(undefined)}
      />
    </DetailPanel>
  );
}

/** Cambia `?credential=` (un id, o `undefined` per chiudere). */
function useGoToCredential() {
  const navigate = useNavigate();
  return useCallback(
    (id: string | undefined) =>
      void navigate({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({ ...prev, credential: id })) as never,
      }),
    [navigate],
  );
}

function CredentialPanelFor({ id, startEditing }: { id: string; startEditing: boolean }) {
  const { t } = useTranslation();
  const go = useGoToCredential();
  const docked = useMediaQuery(CREDENTIAL_PANEL_DOCKED_QUERY);
  const credential = useCredential(id);
  // Dal «⋯» della riga il dettaglio si apre già in modifica (`?edit=1`).
  const [editing, setEditing] = useState(startEditing);
  const close = useCallback(() => go(undefined), [go]);
  const unknown = credential.data === null || credential.isError;
  useEffect(() => {
    if (unknown) close();
  }, [unknown, close]);
  const view = credential.data;
  if (!view) return null;
  return (
    <DetailPanel
      mode={docked ? "docked" : "overlay"}
      label={t("vault.detail.label", { name: view.service })}
      onClose={close}
    >
      {editing ? (
        <CredentialForm
          mode={{ kind: "edit", view }}
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <CredentialBody
          key={view.id}
          view={view}
          onClose={close}
          onEdit={view.canEdit ? () => setEditing(true) : undefined}
        />
      )}
    </DetailPanel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-ink-muted">{label}</span>
      <div className="flex min-h-8 items-center gap-2 text-md text-ink">{children}</div>
    </div>
  );
}

function CredentialBody({
  view,
  onClose,
  onEdit,
}: {
  view: CredentialView;
  onClose: () => void;
  /** Solo con `canEdit`. */
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reveal = usePasswordReveal();
  const manages = view.canEdit || view.canShare;
  const log = useAccessLog(manages ? view.projectId : undefined, view.id);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
      <header className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-lg font-semibold text-ink">{view.service}</h2>
          {view.label && <span className="text-sm text-ink-muted">{view.label}</span>}
        </div>
        {onEdit && (
          <button type="button" className={quietButton} onClick={onEdit}>
            {t("vault.form.edit")}
          </button>
        )}
        <button type="button" className={quietButton} onClick={onClose}>
          {t("vault.detail.close")}
        </button>
      </header>

      <div className="flex flex-col gap-4">
        {view.url && (
          <Field label={t("vault.detail.url")}>
            <button
              type="button"
              className="min-w-0 truncate text-left text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
              aria-label={t("vault.detail.openUrl", { url: view.url })}
              onClick={() => /^https?:\/\//i.test(view.url!) && openInWeb(view.url!)}
            >
              {view.url}
            </button>
          </Field>
        )}
        {view.username && (
          <Field label={t("vault.detail.username")}>
            <span className="min-w-0 flex-1 truncate">{view.username}</span>
            <button
              type="button"
              className={quietButton}
              aria-label={t("vault.detail.copyUsername", { name: view.service })}
              onClick={() => {
                void globalThis.navigator?.clipboard?.writeText(view.username!);
                toast.show(t("vault.detail.usernameCopied"));
              }}
            >
              {t("vault.row.copy")}
            </button>
          </Field>
        )}
        <Field label={t("vault.detail.password")}>
          {view.access === "reads" ? (
            <PasswordField row={view} reveal={reveal} />
          ) : (
            <AccessWord access={view.access} />
          )}
        </Field>
        {view.notes && (
          <Field label={t("vault.detail.notes")}>
            <span className="flex flex-col gap-1">
              <span className="whitespace-pre-wrap">{view.notes}</span>
              <span className="text-xs text-ink-faint">{t("vault.detail.notesHint")}</span>
            </span>
          </Field>
        )}
      </div>

      <CredentialReaders view={view} onChangePassword={onEdit} />

      {manages && (
        <section className="flex flex-col gap-2 border-t border-rule pt-4">
          <h3 className="text-md font-semibold text-ink">{t("vault.detail.log")}</h3>
          {log.data && log.data.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("vault.detail.logEmpty")}</p>
          ) : (
            <ul aria-label={t("vault.detail.log")} className="flex flex-col">
              {(log.data ?? []).map((e) => (
                <li key={e.id} className="flex items-baseline gap-2 py-1 text-sm">
                  <span className="num w-28 shrink-0 text-ink-muted">
                    {new Date(e.at).toLocaleString(undefined, {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="text-ink">{e.name}</span>
                  <span className="text-ink-muted">
                    {t(`vault.detail.${e.action}`)} ·{" "}
                    {e.via === "mac" ? t("vault.detail.fromMac") : t("vault.detail.fromBrowser")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
