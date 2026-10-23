import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { FormError, SubmitButton, TextField } from "../field";
import { secondFactorErrorMessage } from "./second-factor-error";

interface TotpEnrollmentProps<T> {
  /**
   * Chiede al server un segreto nuovo (in attesa di conferma). Iniettata
   * perché la stessa schermata serve al login (`/api/auth/second-factor/
   * enroll`) e a Impostazioni/riconferma (`/api/me/security/totp/setup`).
   */
  start: () => Promise<{ secret: string; otpauthUrl: string }>;
  /** Conferma il primo codice dell'app sul segreto appena chiesto. */
  confirm: (code: string) => Promise<T>;
  /** Codice confermato: riceve la risposta di `confirm` così com'è. */
  onDone: (result: T) => void;
}

/**
 * Configurazione dell'app di autenticazione: QR (SVG disegnato qui da
 * `otpauthUrl`, mai da un servizio esterno: dentro c'è il segreto), il
 * segreto in testo per l'inserimento a mano e il campo del primo codice.
 *
 * `start` parte UNA volta per montaggio (guardia su ref, anche sotto
 * StrictMode): ogni chiamata scrive un segreto in attesa nuovo, e due
 * chiamate in gara lascerebbero a schermo un QR diverso da quello che il
 * server si aspetta.
 */
export function TotpEnrollment<T>({ start, confirm, onDone }: TotpEnrollmentProps<T>) {
  const { t, i18n } = useTranslation();
  const [enrollment, setEnrollment] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const started = useRef(false);

  async function begin() {
    setStartError(null);
    try {
      const { secret, otpauthUrl } = await start();
      // Scuro su chiaro e con margine: lo leggono le fotocamere, non il tema.
      const qrSvg = await QRCode.toString(otpauthUrl, {
        type: "svg",
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
      setEnrollment({ secret, qrSvg });
    } catch (cause) {
      setStartError(secondFactorErrorMessage(cause, t, i18n.language));
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void begin();
    // `begin` va chiamata una volta sola per montaggio (vedi il docblock).
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result = await confirm(code.trim());
      onDone(result);
    } catch (cause) {
      setError(secondFactorErrorMessage(cause, t, i18n.language));
      setPending(false);
    }
  }

  if (startError) {
    return (
      <div className="flex flex-col gap-4">
        <FormError message={startError} />
        <button
          type="button"
          onClick={() => void begin()}
          className="self-start font-mono text-[12px] tracking-[0.08em] text-signal uppercase hover:text-signal-bright"
        >
          {t("common:retry")}
        </button>
      </div>
    );
  }

  if (!enrollment) {
    return <p className="font-mono text-[13px] text-fg-muted">{t("common:loading")}</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <img
        src={`data:image/svg+xml;utf8,${encodeURIComponent(enrollment.qrSvg)}`}
        alt={t("auth:totpEnrollment.qrAlt")}
        className="size-44 self-center rounded-sm bg-white"
      />
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
          {t("auth:totpEnrollment.secretLabel")}
        </span>
        <code className="rounded-sm border border-line bg-ink-950/70 px-3 py-2 font-mono text-[13px] break-all text-fg select-all">
          {enrollment.secret}
        </code>
      </div>
      <TextField
        id="totp-enrollment-code"
        label={t("auth:secondFactor.codeLabel")}
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        value={code}
        onChange={(event) => setCode(event.target.value)}
      />
      <FormError message={error} />
      <SubmitButton pending={pending} disabled={code.trim() === ""}>
        {pending ? t("auth:totpEnrollment.confirmPending") : t("auth:totpEnrollment.confirm")}
      </SubmitButton>
    </form>
  );
}
