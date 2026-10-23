import { startAuthentication } from "@simplewebauthn/browser";
import { useQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  postReauth,
  postReauthPasskeyOptions,
  postReauthPasskeyVerify,
  postReauthTotpSetup,
  postReauthTotpSetupConfirm,
} from "../../lib/api";
import { accountSecurityQueryOptions } from "../../lib/queries";
import { currentReauthRequest, settleReauth, subscribeReauth } from "../../lib/reauth";
import type { ReauthRequest } from "../../lib/reauth";
import { actionButtonClass, actionPrimaryClass, ModalShell } from "../backlog/modal";
import { FormError, TextField } from "../field";
import { BackupCodesPanel } from "./backup-codes-panel";
import { secondFactorErrorMessage } from "./second-factor-error";
import { TotpEnrollment } from "./totp-enrollment";

/**
 * Il dialogo di riconferma, UNO per tutta l'app: montato nel layout
 * autenticato, si apre quando il client API riceve un 403 di riconferma
 * (`lib/reauth.ts`) e l'esito torna a tutte le richieste in attesa, che
 * ripartono una volta se è andato a buon fine.
 *
 * - `reauth_required`: il codice dell'app, un codice di riserva o una passkey;
 * - `second_factor_setup_required` (sessione di prima del rilascio, nessuna
 *   app): la configurazione, poi i codici di riserva — la configurazione
 *   conta già come riconferma.
 *
 * Annullare (bottone, Escape, click fuori) fa arrivare al chiamante l'errore
 * originale, come se il dialogo non ci fosse.
 */
export function ReauthDialog() {
  const request = useSyncExternalStore(subscribeReauth, currentReauthRequest, () => null);
  if (!request) return null;
  return <ReauthModal key={request.id} request={request} />;
}

function ReauthModal({ request }: { request: ReauthRequest }) {
  const { t } = useTranslation();
  // Codici di riserva appena generati dalla configurazione: da qui il dialogo
  // non si chiude più per sbaglio (Escape, click fuori), solo da «Continua».
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const cancel = () => settleReauth(false);

  if (backupCodes) {
    return (
      <ModalShell titleId="reauth-title" onClose={() => undefined}>
        <h2 id="reauth-title" className="text-lg font-semibold">
          {t("auth:secondFactor.backupTitle")}
        </h2>
        <div className="mt-4">
          <BackupCodesPanel codes={backupCodes} onConfirm={() => settleReauth(true)} />
        </div>
      </ModalShell>
    );
  }

  if (request.reason === "second_factor_setup_required") {
    return (
      <ModalShell titleId="reauth-title" onClose={cancel}>
        <h2 id="reauth-title" className="text-lg font-semibold">
          {t("auth:reauth.setupTitle")}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">{t("auth:reauth.setupSubtitle")}</p>
        <div className="mt-4 flex flex-col gap-4">
          <TotpEnrollment
            start={postReauthTotpSetup}
            confirm={postReauthTotpSetupConfirm}
            onDone={(result) => {
              // `null` solo per una «riconfigura app», che da qui non passa:
              // la riconferma c'è comunque, si prosegue.
              const codes = result.backupCodes ?? [];
              if (codes.length > 0) setBackupCodes(codes);
              else settleReauth(true);
            }}
          />
          <button type="button" onClick={cancel} className={`${actionButtonClass} self-end`}>
            {t("auth:reauth.cancel")}
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell titleId="reauth-title" onClose={cancel}>
      <h2 id="reauth-title" className="text-lg font-semibold">
        {t("auth:reauth.title")}
      </h2>
      <p className="mt-1 text-sm text-fg-muted">{t("auth:reauth.subtitle")}</p>
      <ReauthCodeForm onCancel={cancel} />
    </ModalShell>
  );
}

/** Codice dell'app o di riserva (stesso endpoint: il server li distingue), o passkey. */
function ReauthCodeForm({ onCancel }: { onCancel: () => void }) {
  const { t, i18n } = useTranslation();
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Solo per sapere se offrire la passkey: un errore la nasconde e basta.
  const security = useQuery({ ...accountSecurityQueryOptions, retry: false });
  // Difeso: il web non parsa (CLAUDE.md, «NON protegge il web»).
  const hasPasskeys = (security.data?.passkeys ?? []).length > 0;

  async function attempt(run: () => Promise<void>) {
    setError(null);
    setPending(true);
    try {
      await run();
      settleReauth(true);
    } catch (cause) {
      setError(secondFactorErrorMessage(cause, t, i18n.language));
      setPending(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void attempt(() => postReauth(code.trim()));
  }

  function handlePasskey() {
    void attempt(async () => {
      const options = await postReauthPasskeyOptions();
      let response: unknown;
      try {
        response = await startAuthentication({
          optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
        });
      } catch {
        // Annullata, scaduta o rifiutata dal browser: nessun tentativo è
        // arrivato al server, e il motivo preciso non aiuta chi guarda.
        throw new Error(t("auth:secondFactor.passkeyFailed"));
      }
      await postReauthPasskeyVerify(response);
    });
  }

  function toggleBackup() {
    setUseBackup((value) => !value);
    setCode("");
    setError(null);
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <TextField
          id="reauth-code"
          label={
            useBackup ? t("auth:secondFactor.backupCodeLabel") : t("auth:secondFactor.codeLabel")
          }
          inputMode={useBackup ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoFocus
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <FormError message={error} />
        <div className="flex items-center justify-end gap-3">
          <button type="button" onClick={onCancel} className={actionButtonClass}>
            {t("auth:reauth.cancel")}
          </button>
          <button
            type="submit"
            disabled={pending || code.trim() === ""}
            className={actionPrimaryClass}
          >
            {pending ? t("auth:reauth.confirmPending") : t("auth:reauth.confirm")}
          </button>
        </div>
      </form>
      <div className="flex flex-col items-start gap-2 border-t border-line pt-4">
        {hasPasskeys && (
          <button
            type="button"
            onClick={handlePasskey}
            disabled={pending}
            className="font-mono text-[12px] tracking-[0.08em] text-signal uppercase hover:text-signal-bright disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t("auth:secondFactor.usePasskey")}
          </button>
        )}
        <button
          type="button"
          onClick={toggleBackup}
          disabled={pending}
          className="font-mono text-[12px] tracking-[0.08em] text-signal uppercase hover:text-signal-bright disabled:cursor-not-allowed disabled:opacity-60"
        >
          {useBackup ? t("auth:secondFactor.useAppCode") : t("auth:secondFactor.useBackupCode")}
        </button>
      </div>
    </div>
  );
}
