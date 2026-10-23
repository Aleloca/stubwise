import { startRegistration } from "@simplewebauthn/browser";
import type { PasskeyView } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { actionButtonClass, ConfirmDialog } from "../../components/backlog/modal";
import { FormError, SubmitButton, TextField } from "../../components/field";
import { BackupCodesPanel } from "../../components/security/backup-codes-panel";
import { LOW_BACKUP_CODES_THRESHOLD } from "../../components/security/second-factor-error";
import { SecurityEventsList } from "../../components/security/security-events-list";
import { TotpEnrollment } from "../../components/security/totp-enrollment";
import { PasskeySealButton } from "../../components/vault/passkey-seal-button";
import {
  deletePasskey,
  patchPasskey,
  postBackupCodesRegenerate,
  postPasskey,
  postPasskeyRegistrationOptions,
  postTotpSetup,
  postTotpSetupConfirm,
} from "../../lib/api";
import { formatDate } from "../../lib/format";
import { accountSecurityQueryOptions } from "../../lib/queries";
import { translateApiError } from "../../lib/translate-api-error";

/**
 * Impostazioni → Sicurezza (per ogni utente): l'app di autenticazione (con
 * «Riconfigura app»), le passkey (aggiungi, rinomina, togli), i codici di
 * riserva rimasti (con «Rigenera») e il registro di sicurezza dell'account.
 *
 * Niente «disattiva»: il secondo fattore è obbligatorio (design), e qui non
 * c'è un bottone che lo spenga. Si sostituisce, non si toglie.
 *
 * Le scritture che installano o tolgono un fattore chiedono la riconferma
 * recente: passano dal client normale, quindi un 403 `reauth_required` apre il
 * dialogo globale e la richiesta riparte da sola (`lib/reauth.ts`). Ognuna
 * invalida `["me", "security"]`, la chiave che legge anche quel dialogo.
 *
 * ⚠️ Il web non parsa (`lib/api.ts`): ogni campo della risposta si legge
 * difeso, così un server diverso degrada la sezione invece della pagina.
 */
export function SettingsSecurityPage() {
  const { t } = useTranslation();
  const security = useQuery(accountSecurityQueryOptions);

  if (security.isPending) {
    return <p className="font-mono text-[13px] text-fg-muted">{t("common:loading")}</p>;
  }
  if (security.isError) {
    return <FormError message={translateApiError(security.error, t)} />;
  }

  const data = security.data;
  const totp = data.totp ?? { configured: false, confirmedAt: null };
  const passkeys = data.passkeys ?? [];
  const backupCodesRemaining = data.backupCodesRemaining ?? 0;
  const events = data.events ?? [];

  return (
    <div className="space-y-6">
      <p className="text-sm leading-relaxed text-fg-muted">{t("settings:security.description")}</p>
      <TotpSection configured={totp.configured} confirmedAt={totp.confirmedAt} />
      <PasskeysSection passkeys={passkeys} />
      <BackupCodesSection remaining={backupCodesRemaining} />
      <Section title={t("settings:security.events.title")}>
        <SecurityEventsList events={events} />
      </Section>
    </div>
  );
}

/** Riquadro di una sezione, nello stile delle altre sotto-pagine. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {title}
        </h2>
      </header>
      <div className="space-y-4 px-4 py-4">{children}</div>
    </section>
  );
}

function useInvalidateSecurity(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: accountSecurityQueryOptions.queryKey });
}

/**
 * L'app di autenticazione. «Riconfigura app» monta la configurazione: il
 * segreto nuovo resta in attesa, e quello vecchio vale finché il primo codice
 * della nuova non è confermato (lato server). Chi un'app non l'aveva
 * (sessione di prima del rilascio) la configura da qui e riceve i codici di
 * riserva, mostrati una volta.
 */
function TotpSection({
  configured,
  confirmedAt,
}: {
  configured: boolean;
  confirmedAt: string | null;
}) {
  const { t } = useTranslation();
  const invalidate = useInvalidateSecurity();
  const [enrolling, setEnrolling] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [replaced, setReplaced] = useState(false);

  return (
    <Section title={t("settings:security.app.title")}>
      {backupCodes ? (
        <BackupCodesPanel codes={backupCodes} onConfirm={() => setBackupCodes(null)} />
      ) : enrolling ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">{t("settings:security.app.reconfigureHint")}</p>
          <TotpEnrollment
            start={postTotpSetup}
            confirm={postTotpSetupConfirm}
            onDone={(result) => {
              setEnrolling(false);
              void invalidate();
              // Difeso: `backupCodes` è `null` per una riconfigurazione.
              const codes = result.backupCodes ?? [];
              if (codes.length > 0) setBackupCodes(codes);
              else setReplaced(true);
            }}
          />
          <button
            type="button"
            onClick={() => setEnrolling(false)}
            className={`${actionButtonClass} self-start`}
          >
            {t("common:cancel")}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-fg">
            {configured
              ? confirmedAt
                ? t("settings:security.app.configured", { date: formatDate(confirmedAt) })
                : t("settings:security.app.configuredNoDate")
              : t("settings:security.app.notConfigured")}
          </p>
          <button
            type="button"
            onClick={() => {
              setReplaced(false);
              setEnrolling(true);
            }}
            className={actionButtonClass}
          >
            {configured ? t("settings:security.app.reconfigure") : t("settings:security.app.setup")}
          </button>
        </div>
      )}
      {replaced && !enrolling && (
        <p className="text-sm text-ok">{t("settings:security.app.replaced")}</p>
      )}
    </Section>
  );
}

/** Le passkey: elenco con rinomina e rimozione, più il modulo per aggiungerne una. */
function PasskeysSection({ passkeys }: { passkeys: PasskeyView[] }) {
  const { t } = useTranslation();

  return (
    <Section title={t("settings:security.passkeys.title")}>
      <p className="text-sm leading-relaxed text-fg-muted">
        {t("settings:security.passkeys.description")}
      </p>
      {passkeys.length === 0 ? (
        <p className="font-mono text-[13px] text-fg-faint">{t("settings:security.passkeys.empty")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {passkeys.map((passkey) => (
            <PasskeyRow key={passkey.id} passkey={passkey} />
          ))}
        </ul>
      )}
      <AddPasskeyForm />
    </Section>
  );
}

function PasskeyRow({ passkey }: { passkey: PasskeyView }) {
  const { t } = useTranslation();
  const invalidate = useInvalidateSecurity();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(passkey.name);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const rename = useMutation({
    mutationFn: (next: string) => patchPasskey(passkey.id, next),
    onSuccess: async () => {
      await invalidate();
      setRenaming(false);
    },
  });

  const remove = useMutation({
    mutationFn: () => deletePasskey(passkey.id),
    onSuccess: () => invalidate(),
  });

  function handleRename(event: FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (next === "") return;
    rename.mutate(next);
  }

  const error = rename.error ?? remove.error;

  return (
    <li className="flex flex-col gap-2 py-3">
      {renaming ? (
        <form onSubmit={handleRename} className="flex flex-wrap items-end gap-2">
          <TextField
            id={`passkey-rename-${passkey.id}`}
            label={t("settings:security.passkeys.renameLabel", { name: passkey.name })}
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="submit"
            disabled={rename.isPending || name.trim() === ""}
            className={actionButtonClass}
          >
            {t("settings:security.passkeys.save")}
          </button>
          <button
            type="button"
            onClick={() => {
              setRenaming(false);
              setName(passkey.name);
            }}
            className={actionButtonClass}
          >
            {t("common:cancel")}
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <span className="font-mono text-[13px] text-fg">{passkey.name}</span>
            <dl className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-fg-faint">
              <div className="flex gap-1.5">
                <dt>{t("settings:security.passkeys.created")}</dt>
                <dd className="text-fg-muted">{formatDate(passkey.createdAt)}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt>{t("settings:security.passkeys.lastUsed")}</dt>
                <dd className="text-fg-muted">
                  {passkey.lastUsedAt
                    ? formatDate(passkey.lastUsedAt)
                    : t("settings:security.passkeys.neverUsed")}
                </dd>
              </div>
            </dl>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              aria-label={t("settings:security.passkeys.renameAria", { name: passkey.name })}
              onClick={() => {
                setName(passkey.name);
                setRenaming(true);
              }}
              className={actionButtonClass}
            >
              {t("settings:security.passkeys.rename")}
            </button>
            <button
              type="button"
              aria-label={t("settings:security.passkeys.removeAria", { name: passkey.name })}
              onClick={() => setConfirmingRemove(true)}
              className={`${actionButtonClass} hover:border-danger/40 hover:text-danger`}
            >
              {t("settings:security.passkeys.remove")}
            </button>
          </div>
        </div>
      )}
      {!renaming && <PasskeySealButton passkeyId={passkey.id} passkeyName={passkey.name} />}
      <FormError message={error ? translateApiError(error, t) : null} />
      {confirmingRemove && (
        <ConfirmDialog
          title={t("settings:security.passkeys.removeTitle")}
          body={t("settings:security.passkeys.removeBody", { name: passkey.name })}
          confirmLabel={t("settings:security.passkeys.removeConfirm")}
          pending={remove.isPending}
          // Si chiude subito: se serve la riconferma, il suo dialogo non si
          // apre sopra a questo.
          onConfirm={() => {
            setConfirmingRemove(false);
            remove.mutate();
          }}
          onClose={() => setConfirmingRemove(false)}
        />
      )}
    </li>
  );
}

/**
 * Aggiunge una passkey: opzioni dal server (riconferma), la creazione nel
 * browser (`@simplewebauthn/browser`), poi la registrazione col nome scelto.
 */
function AddPasskeyForm() {
  const { t } = useTranslation();
  const invalidate = useInvalidateSecurity();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    setError(null);
    setPending(true);
    try {
      const options = await postPasskeyRegistrationOptions();
      let response: unknown;
      try {
        response = await startRegistration({
          optionsJSON: options as Parameters<typeof startRegistration>[0]["optionsJSON"],
        });
      } catch {
        // Annullata, scaduta o rifiutata dal browser: al server non è
        // arrivato niente, e il motivo preciso non aiuta chi guarda.
        setError(t("settings:security.passkeys.failed"));
        return;
      }
      await postPasskey(trimmed, response);
      setName("");
      await invalidate();
    } catch (cause) {
      setError(translateApiError(cause, t));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
      <TextField
        id="passkey-name"
        label={t("settings:security.passkeys.nameLabel")}
        placeholder={t("settings:security.passkeys.namePlaceholder")}
        maxLength={100}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <FormError message={error} />
      <SubmitButton pending={pending} disabled={name.trim() === ""}>
        {pending ? t("settings:security.passkeys.adding") : t("settings:security.passkeys.add")}
      </SubmitButton>
    </form>
  );
}

/**
 * I codici di riserva: quanti ne restano (avviso a ≤ 3) e «Rigenera», che li
 * sostituisce tutti. I nuovi si mostrano UNA volta: vivono solo nello stato
 * di questo componente, finché non si preme «Continua».
 */
function BackupCodesSection({ remaining }: { remaining: number }) {
  const { t } = useTranslation();
  const invalidate = useInvalidateSecurity();
  const [confirming, setConfirming] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  const regenerate = useMutation({
    mutationFn: postBackupCodesRegenerate,
    onSuccess: async (result) => {
      setCodes(result.codes ?? []);
      await invalidate();
    },
  });

  return (
    <Section title={t("settings:security.backupCodes.title")}>
      <p className="text-sm text-fg">
        {t("settings:security.backupCodes.remaining", { count: remaining })}
      </p>
      {remaining <= LOW_BACKUP_CODES_THRESHOLD && !codes && (
        <p className="rounded-sm border border-signal/30 bg-signal/10 px-3 py-2 text-sm text-fg">
          {t("settings:security.backupCodes.low")}
        </p>
      )}
      {codes ? (
        <BackupCodesPanel codes={codes} onConfirm={() => setCodes(null)} />
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={`${actionButtonClass} self-start`}
        >
          {t("settings:security.backupCodes.regenerate")}
        </button>
      )}
      <FormError message={regenerate.error ? translateApiError(regenerate.error, t) : null} />
      {confirming && (
        <ConfirmDialog
          title={t("settings:security.backupCodes.regenerateTitle")}
          body={t("settings:security.backupCodes.regenerateBody")}
          confirmLabel={t("settings:security.backupCodes.regenerateConfirm")}
          pending={regenerate.isPending}
          // Si chiude subito: se serve la riconferma, il suo dialogo non si
          // apre sopra a questo.
          onConfirm={() => {
            setConfirming(false);
            regenerate.mutate();
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </Section>
  );
}
