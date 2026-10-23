import { startAuthentication } from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { AuthShell } from "../components/auth-shell";
import { FormError, SubmitButton, TextField } from "../components/field";
import { BackupCodesPanel } from "../components/security/backup-codes-panel";
import {
  LOW_BACKUP_CODES_THRESHOLD,
  lockedMessage,
  secondFactorErrorMessage,
} from "../components/security/second-factor-error";
import { TotpEnrollment } from "../components/security/totp-enrollment";
import {
  ApiError,
  getSecondFactorStatus,
  postSecondFactorEnroll,
  postSecondFactorEnrollConfirm,
  postSecondFactorPasskeyOptions,
  postSecondFactorPasskeyVerify,
  postSecondFactorVerify,
} from "../lib/api";
import { meQueryOptions } from "../lib/auth";

const STATUS_QUERY_KEY = ["auth", "second-factor"] as const;

/** Esito di un secondo fattore riuscito (codice o passkey). */
interface VerifyResult {
  /** Opzionale: il web non parsa (CLAUDE.md, «NON protegge il web»). */
  backupCodesRemaining?: number;
}

/**
 * Secondo passo del login (`/login/second-factor`): ci si arriva dopo una
 * password giusta, con la sessione PARZIALE, o dalla guardia del layout
 * autenticato su un 401 `second_factor_required`.
 *
 * - stadio `second_factor`: codice dell'app, oppure un codice di riserva, o
 *   una passkey se l'utente ne ha;
 * - stadio `enrollment`: configurazione obbligatoria dell'app, poi i codici di
 *   riserva mostrati una volta. Solo allora si entra.
 *
 * Lo stato si legge UNA volta per visita (costa un tentativo del bucket per IP
 * delle credenziali): niente retry, niente refetch al focus, niente cache fra
 * una visita e l'altra.
 */
export function LoginSecondFactorPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();
  const [lowBackupCodes, setLowBackupCodes] = useState<number | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  const status = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: getSecondFactorStatus,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  async function enter() {
    // Come dopo il login: `/me` si ricarica dalla guardia del layout, con la
    // sessione ormai completa.
    queryClient.removeQueries({ queryKey: meQueryOptions.queryKey });
    queryClient.removeQueries({ queryKey: STATUS_QUERY_KEY });
    await navigate({ to: "/tickets" });
  }

  function verified(result: VerifyResult) {
    // Un campo assente NON è «zero codici»: niente falso allarme.
    const remaining = result.backupCodesRemaining;
    if (remaining !== undefined && remaining <= LOW_BACKUP_CODES_THRESHOLD) {
      setLowBackupCodes(remaining);
      return;
    }
    void enter();
  }

  const statusError = status.error;
  useEffect(() => {
    if (!(statusError instanceof ApiError)) return;
    // Già entrato (sessione completa): niente da fare qui.
    if (statusError.code === "second_factor_done") void enter();
    // Nessuna sessione parziale (scaduta dopo 10 minuti, o mai aperta).
    else if (statusError.status === 401) void navigate({ to: "/login" });
    // `enter`/`navigate` cambiano a ogni render: conta solo l'errore.
  }, [statusError]);

  function backToLogin() {
    void navigate({ to: "/login" });
  }

  if (backupCodes) {
    return (
      <AuthShell
        title={t("auth:secondFactor.backupTitle")}
        subtitle={t("auth:secondFactor.backupSubtitle")}
      >
        <BackupCodesPanel codes={backupCodes} onConfirm={() => void enter()} />
      </AuthShell>
    );
  }

  if (lowBackupCodes !== null) {
    return (
      <AuthShell title={t("auth:secondFactor.title")} subtitle={t("auth:secondFactor.signedIn")}>
        <div className="flex flex-col gap-4">
          <p className="rounded-sm border border-signal/30 bg-signal/10 px-3 py-2 text-sm text-fg">
            {t("auth:secondFactor.lowBackupCodes", { count: lowBackupCodes })}{" "}
            {t("auth:secondFactor.lowBackupCodesHint")}{" "}
            {/* `<a>` e non `Link`: la rotta di Impostazioni → Sicurezza è di un task successivo. */}
            <a href="/settings/security" className="text-signal underline hover:text-signal-bright">
              {t("auth:secondFactor.securityLink")}
            </a>
          </p>
          <button
            type="button"
            onClick={() => void enter()}
            className="rounded-sm bg-signal px-3 py-2.5 font-mono text-[13px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {t("auth:secondFactor.continue")}
          </button>
        </div>
      </AuthShell>
    );
  }

  if (status.isPending) {
    return (
      <AuthShell title={t("auth:secondFactor.title")} subtitle={t("auth:secondFactor.subtitle")}>
        <p className="font-mono text-[13px] text-fg-muted">{t("common:loading")}</p>
      </AuthShell>
    );
  }

  if (status.isError) {
    return (
      <AuthShell title={t("auth:secondFactor.title")} subtitle={t("auth:secondFactor.subtitle")}>
        <div className="flex flex-col gap-4">
          <FormError message={secondFactorErrorMessage(status.error, t, i18n.language)} />
          <BackToLogin onClick={backToLogin} />
        </div>
      </AuthShell>
    );
  }

  if (status.data.stage === "enrollment") {
    return (
      <AuthShell
        title={t("auth:secondFactor.enrollTitle")}
        subtitle={t("auth:secondFactor.enrollSubtitle")}
      >
        <div className="flex flex-col gap-4">
          <TotpEnrollment
            start={postSecondFactorEnroll}
            confirm={postSecondFactorEnrollConfirm}
            onDone={(result) => setBackupCodes(result.backupCodes ?? [])}
          />
          <BackToLogin onClick={backToLogin} />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t("auth:secondFactor.title")} subtitle={t("auth:secondFactor.subtitle")}>
      <div className="flex flex-col gap-4">
        <SecondFactorCodeForm
          passkeys={status.data.passkeys ?? false}
          lockedUntil={status.data.lockedUntil ?? null}
          onVerified={verified}
        />
        <BackToLogin onClick={backToLogin} />
      </div>
    </AuthShell>
  );
}

function BackToLogin({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="self-center font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase hover:text-fg-muted"
    >
      {t("auth:secondFactor.backToLogin")}
    </button>
  );
}

interface SecondFactorCodeFormProps {
  passkeys: boolean;
  /** Blocco già in corso all'apertura della pagina (ISO), o null. */
  lockedUntil: string | null;
  onVerified: (result: VerifyResult) => void;
}

/**
 * Il codice dell'app, oppure un codice di riserva (stesso endpoint: il server
 * li distingue), oppure una passkey.
 */
function SecondFactorCodeForm({ passkeys, lockedUntil, onVerified }: SecondFactorCodeFormProps) {
  const { t, i18n } = useTranslation();
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(() =>
    lockedUntil !== null && new Date(lockedUntil).getTime() > Date.now()
      ? lockedMessage(lockedUntil, t, i18n.language)
      : null,
  );
  const [pending, setPending] = useState(false);

  async function attempt(run: () => Promise<VerifyResult>) {
    setError(null);
    setPending(true);
    try {
      onVerified(await run());
    } catch (cause) {
      setError(secondFactorErrorMessage(cause, t, i18n.language));
      setPending(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void attempt(() => postSecondFactorVerify(code.trim()));
  }

  function handlePasskey() {
    void attempt(async () => {
      const options = await postSecondFactorPasskeyOptions();
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
      return postSecondFactorPasskeyVerify(response);
    });
  }

  function toggleBackup() {
    setUseBackup((value) => !value);
    setCode("");
    setError(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <TextField
          id="second-factor-code"
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
        <SubmitButton pending={pending} disabled={code.trim() === ""}>
          {pending ? t("auth:secondFactor.submitPending") : t("auth:secondFactor.submit")}
        </SubmitButton>
      </form>
      <div className="flex flex-col items-start gap-2 border-t border-line pt-4">
        {passkeys && (
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
