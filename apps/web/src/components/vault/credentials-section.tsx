import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteCredential, type CredentialItem } from "../../lib/api";
import { useCanFn } from "../../lib/permissions";
import { projectCredentialsQueryOptions, vaultStatusQueryOptions } from "../../lib/queries";
import { translateApiError } from "../../lib/translate-api-error";
import { useVault } from "../../lib/vault/vault-context";
import { ConfirmDeleteButton } from "../confirm-delete-button";
import { FormError } from "../field";
import { AccessLog } from "./access-log";
import { CredentialForm, credentialName } from "./credential-form";
import { ReadersPanel } from "./readers-panel";
import { RevealButtons } from "./reveal-button";

// Stesso titolo delle sezioni del dettaglio progetto («Membri»).
const sectionTitleClass =
  "mb-3 font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase";
const smallButtonClass =
  "tap rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

/** Un URL si mostra come link solo se è http(s): il campo è testo libero. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Le credenziali per servizio, nell'ordine dei servizi e poi delle etichette. */
export function groupByService(items: CredentialItem[]): Array<[string, CredentialItem[]]> {
  const groups = new Map<string, CredentialItem[]>();
  for (const item of items) {
    const group = groups.get(item.service) ?? [];
    group.push(item);
    groups.set(item.service, group);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([service, group]) => [
      service,
      [...group].sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "")),
    ]);
}

/**
 * Avviso per chi ha la chiave in attesa (Task 9 lo lascia qui): l'accesso
 * c'è, ma aspetta che una persona confermi la chiave.
 */
export function KeyPendingNotice() {
  const { t } = useTranslation();
  const { data: status } = useQuery({ ...vaultStatusQueryOptions, retry: false });
  if (status?.myKey?.status !== "pending") return null;
  return (
    <p role="status" className="rounded-sm border border-signal/40 bg-signal/10 p-3 text-sm">
      {t("vault:credentials.keyPending")}
    </p>
  );
}

/**
 * Elenco raggruppato per servizio (design «Dove sta nella web»): servizio,
 * etichetta, utente, URL — mai la password, che si apre una voce alla volta
 * con Mostra / Copia. `manage` aggiunge modifica, eliminazione e lettori
 * secondo `canEdit`/`canShare` calcolati dal server.
 */
export function CredentialGroups({
  items,
  projectId,
  manage,
}: {
  items: CredentialItem[];
  projectId?: string;
  manage: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {groupByService(items).map(([service, group]) => (
        <section key={service} aria-label={service} className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold text-fg">{service}</h3>
          <ul className="rounded-sm border border-line bg-ink-900">
            {group.map((item) => (
              <CredentialRow
                key={item.id}
                item={item}
                projectId={projectId ?? item.projectId}
                manage={manage}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function CredentialRow({
  item,
  projectId,
  manage,
}: {
  item: CredentialItem;
  projectId: string;
  manage: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const name = credentialName(item);
  // Campi aggiunti dopo: un server più vecchio non li manda (il web non parsa).
  const canEdit = manage && (item.canEdit ?? false);
  const canShare = manage && (item.canShare ?? false);
  const [editing, setEditing] = useState<null | "fields" | "password">(null);
  const [readersOpen, setReadersOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const href = item.url ? safeHref(item.url) : null;

  const removal = useMutation({
    mutationFn: () => deleteCredential(item.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["credentials"] }),
    onError: (cause) => setError(translateApiError(cause, t)),
  });

  return (
    <li
      aria-label={name}
      className="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm text-fg">{item.label ?? item.service}</span>
          {item.username && (
            <span className="truncate font-mono text-[12px] text-fg-muted">{item.username}</span>
          )}
          {item.url &&
            (href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="truncate font-mono text-[12px] text-signal underline"
              >
                {item.url}
              </a>
            ) : (
              <span className="truncate font-mono text-[12px] text-fg-faint">{item.url}</span>
            ))}
          {item.notes && (
            <p className="mt-1 text-[13px] whitespace-pre-wrap text-fg-faint">{item.notes}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {item.access === "read" ? (
            <RevealButtons credentialId={item.id} name={name} />
          ) : (
            <span className="rounded-sm border border-line-strong px-1.5 py-0.5 font-mono text-[10px] tracking-[0.12em] text-fg-muted uppercase">
              {item.access === "pending"
                ? t("vault:credentials.access.pending")
                : t("vault:credentials.access.manage")}
            </span>
          )}
          {(canEdit || canShare) && (
            <span className="flex flex-wrap items-center justify-end gap-2">
              {canShare && (
                <button
                  type="button"
                  onClick={() => setReadersOpen((open) => !open)}
                  aria-expanded={readersOpen}
                  aria-label={t("vault:credentials.readers.openAria", { name })}
                  className={smallButtonClass}
                >
                  {t("vault:credentials.readers.open")}
                </button>
              )}
              {canEdit && (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing((mode) => (mode ? null : "fields"))}
                    aria-label={t("vault:credentials.editAria", { name })}
                    className={smallButtonClass}
                  >
                    {t("vault:credentials.edit")}
                  </button>
                  <ConfirmDeleteButton
                    label={t("vault:credentials.delete")}
                    labelAria={t("vault:credentials.deleteAria", { name })}
                    confirmLabel={t("vault:credentials.confirmDelete")}
                    confirmAria={t("vault:credentials.confirmDeleteAria", { name })}
                    pending={removal.isPending}
                    onConfirm={() => {
                      setError(null);
                      removal.mutate();
                    }}
                  />
                </>
              )}
            </span>
          )}
        </div>
      </div>
      <FormError message={error} />
      {readersOpen && canShare && (
        <ReadersPanel
          projectId={projectId}
          credentialId={item.id}
          name={name}
          canEdit={canEdit}
          onChangePassword={() => setEditing("password")}
        />
      )}
      {editing && canEdit && (
        <CredentialForm
          // Una chiave per modo: «Cambia la password» rimonta il form col fuoco sulla password.
          key={editing}
          projectId={projectId}
          credential={item}
          focusPassword={editing === "password"}
          onDone={() => setEditing(null)}
        />
      )}
    </li>
  );
}

/**
 * Sezione «Credenziali» del progetto (design «Dove sta nella web»), accanto a
 * «Membri». Non c'è finché la cassaforte non è attivata sull'istanza. Ognuno
 * vede ciò che legge; chi ha `credentials.edit`/`credentials.share` vede
 * anche le altre, senza password (le filtra il server). Il registro delle
 * letture è di chi gestisce.
 */
export function CredentialsSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const vault = useVault();
  const can = useCanFn();
  const active = vault.state !== "inactive";
  const credentials = useQuery({ ...projectCredentialsQueryOptions(projectId), enabled: active });
  const [creating, setCreating] = useState(false);

  if (!active) return null;

  const canCreate = can("credentials.create", projectId);
  const canSeeLog = can("credentials.share", projectId) || can("credentials.edit", projectId);
  const items = credentials.data?.items ?? [];

  return (
    <section aria-label={t("vault:credentials.title")} className="mt-8 border-t border-line pt-6">
      <h2 className={sectionTitleClass}>{t("vault:credentials.title")}</h2>
      <div className="flex flex-col gap-4">
        <KeyPendingNotice />
        {credentials.isPending ? (
          <p className="font-mono text-[12px] text-fg-faint">{t("vault:credentials.loading")}</p>
        ) : credentials.isError ? (
          <FormError message={translateApiError(credentials.error, t)} />
        ) : items.length === 0 ? (
          <p className="font-mono text-[12px] text-fg-faint">{t("vault:credentials.empty")}</p>
        ) : (
          <CredentialGroups items={items} projectId={projectId} manage />
        )}
        {canCreate &&
          (creating ? (
            <CredentialForm projectId={projectId} onDone={() => setCreating(false)} />
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="self-start rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
            >
              {t("vault:credentials.add")}
            </button>
          ))}
        {canSeeLog && <AccessLog projectId={projectId} />}
      </div>
    </section>
  );
}
