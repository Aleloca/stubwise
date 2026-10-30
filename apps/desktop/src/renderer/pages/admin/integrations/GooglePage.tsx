import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { maskedSecret } from "../../../components/SecretField";
import { useGoogleApps, type GoogleAppView } from "../../../data/queries";
import { ReadError, RowMenu, RowMenuItem } from "../../preferences/parts";
import { primaryButton } from "../../tasks/controls";
import { AiSkeleton } from "../ai/parts";
import {
  AddGoogleAppDialog,
  DeleteGoogleAppDialog,
  EditGoogleAppDialog,
  ReplaceGoogleSecretDialog,
} from "./GoogleAppDialog";
import { Dot, IntegrationPage } from "./parts";

// Google Workspace (shape admin-integrations.md «Google Workspace»): le app
// Google con cui le persone collegano Gmail e Calendar in Preferenze →
// Account, una riga per app coi suoi domini, la coda del client secret e
// quante caselle sono collegate. La voce c'è solo con
// `integrations.manage` (senza, «not found»): chi la apre può anche
// scriverci, quindi niente sola lettura. Nessuna prova: un'app non si
// verifica da qui, e la riga non ha bottoni oltre al «⋯».

/** Quanto resta evidenziata la riga appena creata. */
const ADDED_MS = 2000;

type Dialog =
  | { kind: "add" }
  | { kind: "edit" | "replace" | "delete"; app: GoogleAppView };

export function GooglePage() {
  const { t } = useTranslation();
  const apps = useGoogleApps();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    if (!added) return;
    const timer = window.setTimeout(() => setAdded(null), ADDED_MS);
    return () => window.clearTimeout(timer);
  }, [added]);

  const add = (
    <button type="button" onClick={() => setDialog({ kind: "add" })} className={primaryButton}>
      {t("admin.google.add")}
    </button>
  );

  return (
    <IntegrationPage title={t("admin.google.title")} intro={t("admin.google.intro")} action={add}>
      {apps.isPending ? (
        <AiSkeleton rows={2} height={60} />
      ) : apps.isError ? (
        <ReadError message={t("admin.google.loadError")} onRetry={() => void apps.refetch()} />
      ) : apps.data.length === 0 ? (
        <div className="mt-6 border-t border-rule pt-5">
          <p className="text-md text-ink">{t("admin.google.empty")}</p>
        </div>
      ) : (
        <ul aria-label={t("admin.google.list")} className="mt-6 border-t border-rule">
          {apps.data.map((a) => (
            <GoogleAppRow
              key={a.id}
              app={a}
              justAdded={added === a.id}
              onOpen={(kind) => setDialog({ kind, app: a })}
            />
          ))}
        </ul>
      )}
      {dialog?.kind === "add" && (
        <AddGoogleAppDialog
          apps={apps.data ?? []}
          onClose={() => setDialog(null)}
          onCreated={setAdded}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditGoogleAppDialog
          app={dialog.app}
          apps={apps.data ?? []}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "replace" && (
        <ReplaceGoogleSecretDialog app={dialog.app} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && (
        <DeleteGoogleAppDialog app={dialog.app} onClose={() => setDialog(null)} />
      )}
    </IntegrationPage>
  );
}

/**
 * Un'app (60 px, due righe). Prima: nome · domini, a destra «⋯». Seconda:
 * il client ID troncato, la coda del secret, le caselle collegate; stretta
 * (1024) va a capo.
 */
function GoogleAppRow({
  app: a,
  justAdded,
  onOpen,
}: {
  app: GoogleAppView;
  justAdded: boolean;
  onOpen: (kind: "edit" | "replace" | "delete") => void;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const ref = useRef<HTMLLIElement>(null);
  const domains = a.domains.join(", ");

  // Dopo la creazione il fuoco va alla riga nuova (shape §6).
  useEffect(() => {
    if (justAdded) ref.current?.focus();
  }, [justAdded]);

  return (
    <li
      ref={ref}
      tabIndex={-1}
      aria-labelledby={nameId}
      className={`border-b border-rule outline-none transition-colors duration-[var(--duration-base)] ease-out focus-visible:bg-ink/4 ${justAdded ? "bg-ink/6" : ""}`}
    >
      <div className="flex min-h-[60px] flex-col justify-center gap-1 py-2 pr-1 pl-1">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span
              id={nameId}
              title={a.name}
              className="max-w-[50%] shrink-0 truncate text-md font-semibold text-ink"
            >
              {a.name}
            </span>
            <span title={domains} className="min-w-0 truncate text-sm text-ink-muted">
              {domains}
            </span>
          </span>
          <RowMenu label={t("admin.google.menu", { name: a.name })}>
            {(close) => (
              <>
                <RowMenuItem onSelect={() => (close(false), onOpen("edit"))}>
                  {t("admin.google.edit")}
                </RowMenuItem>
                <RowMenuItem onSelect={() => (close(false), onOpen("replace"))}>
                  {t("admin.google.replaceSecret")}
                </RowMenuItem>
                <RowMenuItem onSelect={() => (close(false), onOpen("delete"))}>
                  {t("admin.google.delete")}
                </RowMenuItem>
              </>
            )}
          </RowMenu>
        </div>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-ink-muted">
          <span title={a.clientId} className="num max-w-[40ch] min-w-0 truncate">
            {a.clientId}
          </span>
          <Dot />
          <span className="num shrink-0">{maskedSecret(a.last4)}</span>
          <Dot />
          <span className="shrink-0">
            {a.mailboxCount > 0
              ? t("admin.google.mailboxes", { count: a.mailboxCount })
              : t("admin.google.noMailboxes")}
          </span>
        </p>
      </div>
    </li>
  );
}
