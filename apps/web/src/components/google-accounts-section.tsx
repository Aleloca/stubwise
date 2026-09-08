import { googleCallbackOutcomes, type GoogleCallbackOutcome } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deleteMyGoogleAccount,
  patchMyGoogleAccount,
  postMyGoogleConnect,
  type GoogleAccount,
} from "../lib/api";
import { formatDateTime } from "../lib/format";
import {
  myGoogleAccountsQueryOptions,
  myGoogleWorkspaceOptionsQueryOptions,
} from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";

/**
 * Sezione «Caselle Google» della pagina Account (fase 6): le caselle Gmail /
 * Calendar che l'utente ha collegato, e il pulsante per collegarne una.
 *
 * È una sezione PERSONALE, non amministrativa: ci passa qualunque utente
 * autenticato, e le rotte dietro (`/api/me/google/*`) filtrano tutto per
 * `user_id`. L'amministrazione dei Workspace — le app OAuth su cui queste
 * caselle si appoggiano — è un'altra pagina, riservata agli admin.
 *
 * L'esito del consenso arriva come **prop**, non letto qui dalla URL: il
 * callback OAuth è una rotta del server che rimanda a
 * `/settings/account?google=<esito>`, e chi possiede quel query param è la
 * route (`settings/account.tsx`, con `validateSearch`). Tenerlo fuori dal
 * componente lo rende renderizzabile — e testabile — senza un router.
 */

/** Un esito riconosciuto, o `null` se il param è assente o è spazzatura. */
function toOutcome(raw: string | undefined): GoogleCallbackOutcome | null {
  if (!raw) return null;
  return (googleCallbackOutcomes as readonly string[]).includes(raw)
    ? (raw as GoogleCallbackOutcome)
    : null;
}

export function GoogleAccountsSection({ outcome: rawOutcome }: { outcome?: string | undefined }) {
  const { t } = useTranslation();
  const { data: accounts } = useSuspenseQuery(myGoogleAccountsQueryOptions);
  const [connecting, setConnecting] = useState(false);
  const outcome = toOutcome(rawOutcome);

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:account.googleAccounts.title")}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">
            {t("settings:account.googleAccounts.subtitle")}
          </p>
        </div>
        {!connecting && (
          <button
            type="button"
            onClick={() => setConnecting(true)}
            className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {t("settings:account.googleAccounts.connect")}
          </button>
        )}
      </header>

      {outcome && <OutcomeBanner outcome={outcome} />}

      {connecting && <ConnectPicker onCancel={() => setConnecting(false)} />}

      {accounts.length === 0 ? (
        <p className="px-4 py-4 font-mono text-[12px] text-fg-faint">
          {t("settings:account.googleAccounts.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {accounts.map((account) => (
            <AccountRow key={account.id} account={account} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * L'esito del consenso, in cima alla sezione.
 *
 * I tre rifiuti hanno messaggi DIVERSI e non un «errore, riprova» unico perché
 * chiedono all'utente tre azioni diverse: `domain_mismatch` → hai scelto
 * l'account sbagliato; `no_refresh_token` → devi revocare l'accesso su Google
 * prima di riprovare (è l'unica via d'uscita, e senza istruzione l'utente
 * riproverebbe all'infinito con lo stesso esito); `insufficient_scope` → devi
 * lasciare spuntate tutte le autorizzazioni.
 */
function OutcomeBanner({ outcome }: { outcome: GoogleCallbackOutcome }) {
  const { t } = useTranslation();
  const ok = outcome === "ok";
  return (
    <p
      role="status"
      className={`mx-4 mt-4 rounded-sm border px-3 py-2.5 font-mono text-[12px] ${
        ok ? "border-ok/30 bg-ok/10 text-ok" : "border-danger/30 bg-danger/10 text-danger"
      }`}
    >
      {t(`settings:account.googleAccounts.outcome.${outcome}`)}
    </p>
  );
}

/**
 * Scelta del Workspace e avvio del consenso.
 *
 * ⚠️ La navigazione è un `window.location.href`, non un `<Link>`: la
 * destinazione è `accounts.google.com`, fuori dalla SPA, e il router di
 * TanStack non c'entra nulla. Il server risponde con la URL invece di
 * reindirizzare proprio perché una `fetch` seguirebbe il 302 in background.
 */
function ConnectPicker({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  // `useQuery` e non `useSuspenseQuery`: il picker si apre DENTRO una sezione
  // già montata, e sospendere qui farebbe sparire l'elenco delle caselle (il
  // confine di Suspense più vicino è la route) per il tempo di una fetch.
  const { data: workspaces, isPending } = useQuery(myGoogleWorkspaceOptionsQueryOptions);
  const usable = (workspaces ?? []).filter((workspace) => workspace.clientSecretSet);
  // Lo stato tiene la sola scelta ESPLICITA dell'utente; il valore mostrato
  // ripiega sul primo Workspace utilizzabile. Inizializzare lo stato con
  // `usable[0]` non funzionerebbe: al primo render l'elenco è ancora in volo, e
  // l'inizializzatore di `useState` gira una volta sola — la select resterebbe
  // vuota per sempre.
  const [chosen, setChosen] = useState("");
  const selected = chosen || usable[0]?.id || "";

  const mutation = useMutation({
    mutationFn: (workspaceId: string) => postMyGoogleConnect(workspaceId),
    onSuccess: (result) => {
      window.location.href = result.authorizeUrl;
    },
  });

  if (isPending) {
    return (
      <p className="border-b border-line px-4 py-4 font-mono text-[12px] text-fg-faint">
        {t("common:loading")}
      </p>
    );
  }

  if (usable.length === 0) {
    return (
      <div className="border-b border-line px-4 py-4">
        <p className="font-mono text-[12px] text-fg-muted">
          {t("settings:account.googleAccounts.noWorkspace")}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 rounded-sm px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
        >
          {t("common:cancel")}
        </button>
      </div>
    );
  }

  return (
    <form
      className="space-y-3 border-b border-line px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected) mutation.mutate(selected);
      }}
    >
      <div className="flex flex-col gap-1">
        <label
          htmlFor="google-connect-workspace"
          className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase"
        >
          {t("settings:account.googleAccounts.workspace")}
        </label>
        <select
          id="google-connect-workspace"
          value={selected}
          onChange={(event) => setChosen(event.target.value)}
          className="w-fit rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        >
          {usable.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name} — {workspace.domains.join(", ")}
            </option>
          ))}
        </select>
      </div>

      {mutation.error && (
        <p role="alert" className="font-mono text-[12px] text-danger">
          {translateApiError(mutation.error, t)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={mutation.isPending || !selected}
          className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t("settings:account.googleAccounts.authorize")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-sm px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
        >
          {t("common:cancel")}
        </button>
      </div>
    </form>
  );
}

/** Riga di una casella: identità, stato, scope, toggle e azioni. */
function AccountRow({ account }: { account: GoogleAccount }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const disabled = account.disabledAt !== null;

  const toggle = useMutation({
    mutationFn: (proposalsEnabled: boolean) =>
      patchMyGoogleAccount(account.id, { proposalsEnabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: myGoogleAccountsQueryOptions.queryKey });
    },
  });

  const disconnect = useMutation({
    mutationFn: () => deleteMyGoogleAccount(account.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: myGoogleAccountsQueryOptions.queryKey });
    },
  });

  const reconnect = useMutation({
    mutationFn: () => postMyGoogleConnect(account.workspaceId),
    onSuccess: (result) => {
      window.location.href = result.authorizeUrl;
    },
  });

  const error = toggle.error ?? disconnect.error ?? reconnect.error;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-[13px] text-fg">{account.email}</span>
        <span className="font-mono text-[11px] text-fg-muted">{account.workspaceName}</span>
        <span
          className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${
            disabled ? "border-danger/40 text-danger" : "border-ok/40 text-ok"
          }`}
        >
          {disabled
            ? t("settings:account.googleAccounts.disabled")
            : t("settings:account.googleAccounts.active")}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {disabled && (
            <RowButton
              onClick={() => reconnect.mutate()}
              disabled={reconnect.isPending}
              label={t("settings:account.googleAccounts.reconnect")}
            />
          )}
          {confirmingDelete ? (
            <>
              <RowButton
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
                label={t("settings:account.googleAccounts.confirmDisconnect")}
                danger
              />
              <RowButton onClick={() => setConfirmingDelete(false)} label={t("common:cancel")} />
            </>
          ) : (
            <RowButton
              onClick={() => setConfirmingDelete(true)}
              label={t("settings:account.googleAccounts.disconnect")}
              danger
            />
          )}
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-fg-faint">
        {disabled && account.disabledReason && (
          <span className="text-danger">
            {t(`settings:account.googleAccounts.reason.${account.disabledReason}`, {
              defaultValue: account.disabledReason,
            })}
          </span>
        )}
        <span>
          {account.lastSyncAt
            ? t("settings:account.googleAccounts.lastSync", {
                date: formatDateTime(account.lastSyncAt),
              })
            : t("settings:account.googleAccounts.neverSynced")}
        </span>
        {/* Solo il nome corto degli scope: la URL intera occuperebbe la riga
            senza dire nulla di più a chi la legge. */}
        <span className="break-all">
          {account.scopes.map((scope) => scope.split("/").pop()).join(", ")}
        </span>
      </div>

      <label className="mt-2 flex w-fit items-center gap-2 text-[13px] text-fg">
        <input
          type="checkbox"
          checked={account.proposalsEnabled}
          disabled={toggle.isPending}
          onChange={(event) => toggle.mutate(event.target.checked)}
          className="size-4 accent-signal disabled:cursor-not-allowed"
        />
        <span>{t("settings:account.googleAccounts.proposalsEnabled")}</span>
      </label>

      {error && (
        <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
          {translateApiError(error, t)}
        </p>
      )}
    </li>
  );
}

function RowButton({
  onClick,
  label,
  disabled,
  danger,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-sm border bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? "border-danger/30 text-danger hover:border-danger/60"
          : "border-line-strong text-fg-muted hover:border-ink-700 hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}
