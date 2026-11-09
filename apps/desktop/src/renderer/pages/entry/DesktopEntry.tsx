import { Navigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useEntryGate } from "../../data/queries";
import { useViewer } from "../../data/viewing";
import {
  cancelBrowserLogin,
  onDesktopSessionChanged,
  readInstanceUrl,
  startBrowserLogin,
  writeInstanceUrl,
} from "../../platform/desktopSession";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { BusyLabel, EntryColumn, EntryField, EntryHeading, ErrorLine, textButton } from "./parts";

/**
 * L'ingresso dell'app desktop (integrazione area 2, «Aggiunta del 9 nov
 * 2026: il login»): niente modulo di password. Prima l'indirizzo
 * dell'istanza, poi «Sign in with your browser»: il login (password, codice
 * o passkey) avviene sulle pagine di `/app` nel browser di sistema, che
 * riapre l'app con un codice monouso. Il processo main lo scambia col token,
 * e qui arriva solo l'esito (`session:changed`).
 */
type Step =
  | { kind: "loading" }
  | { kind: "address"; draft: string }
  | { kind: "start"; url: string }
  | { kind: "waiting"; url: string };

/** La frase di un errore del login dal browser: mai il codice grezzo. */
function errorKey(code: string | undefined): string {
  switch (code) {
    case "no_instance":
      return "entry.desktop.errors.noInstance";
    case "network_error":
      return "entry.desktop.errors.network";
    case "invalid_grant":
      return "entry.desktop.errors.notFinished";
    case "unauthorized":
      return "entry.desktop.errors.sessionEnded";
    default:
      return "entry.desktop.errors.generic";
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function DesktopEntry() {
  const { t } = useTranslation();
  const { stage } = useEntryGate();
  const { setPersona } = useViewer();
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void readInstanceUrl().then((url) => {
      if (alive) setStep(url ? { kind: "start", url } : { kind: "address", draft: "" });
    });
    return () => {
      alive = false;
    };
  }, []);

  // L'esito del login dal browser: dentro rilegge la sessione (il token ora
  // c'è), un errore torna all'avvio con una frase.
  useEffect(
    () =>
      onDesktopSessionChanged((change) => {
        if (change.signedIn) {
          setError(null);
          setPersona("");
          return;
        }
        setError(t(errorKey(change.error)));
        setStep((s) => (s.kind === "waiting" ? { kind: "start", url: s.url } : s));
      }),
    [setPersona, t],
  );

  if (stage === "in") return <Navigate to="/home" replace />;

  async function saveAddress(e: FormEvent, draft: string) {
    e.preventDefault();
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError(null);
    const r = await writeInstanceUrl(draft.trim());
    setBusy(false);
    if (r.ok && r.url) setStep({ kind: "start", url: r.url });
    else setError(t("entry.desktop.address.invalid"));
  }

  async function begin(url: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await startBrowserLogin();
    setBusy(false);
    if (r.ok) {
      setStep({ kind: "waiting", url });
      return;
    }
    setError(t(errorKey(r.code)));
    if (r.code === "no_instance") setStep({ kind: "address", draft: url });
  }

  async function cancel(url: string) {
    await cancelBrowserLogin();
    setStep({ kind: "start", url });
  }

  return (
    <EntryColumn>
      <div key={step.kind} className="entry-enter">
        {step.kind === "address" && (
          <>
            <EntryHeading title={t("entry.desktop.address.title")} lead={t("entry.desktop.address.lead")} />
            <form onSubmit={(e) => void saveAddress(e, step.draft)} noValidate className="flex flex-col gap-4">
              <EntryField
                label={t("entry.desktop.address.label")}
                type="url"
                inputMode="url"
                autoComplete="url"
                autoFocus
                placeholder="https://stubwise.example.com"
                value={step.draft}
                onChange={(e) => setStep({ kind: "address", draft: e.target.value })}
              />
              {error && <ErrorLine>{error}</ErrorLine>}
              <div className="flex justify-end">
                <button type="submit" className={primaryButton} aria-busy={busy} disabled={!step.draft.trim()}>
                  <BusyLabel busy={busy} idle={t("entry.desktop.address.submit")} pending={t("entry.desktop.address.saving")} />
                </button>
              </div>
            </form>
          </>
        )}
        {step.kind === "start" && (
          <>
            <EntryHeading title={t("entry.desktop.start.title")} lead={t("entry.desktop.start.lead")} />
            <div className="flex flex-col gap-4">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-ink-muted">
                <span>{t("entry.desktop.start.instance")}</span>
                <span className="font-medium text-ink">{hostOf(step.url)}</span>
                <button
                  type="button"
                  className={textButton}
                  onClick={() => {
                    setError(null);
                    setStep({ kind: "address", draft: step.url });
                  }}
                >
                  {t("entry.desktop.start.change")}
                </button>
              </p>
              {error && <ErrorLine>{error}</ErrorLine>}
              <div className="flex justify-end">
                <button type="button" className={primaryButton} aria-busy={busy} onClick={() => void begin(step.url)}>
                  <BusyLabel busy={busy} idle={t("entry.desktop.start.submit")} pending={t("entry.desktop.start.opening")} />
                </button>
              </div>
            </div>
          </>
        )}
        {step.kind === "waiting" && (
          <>
            <EntryHeading
              title={t("entry.desktop.waiting.title")}
              lead={t("entry.desktop.waiting.lead", { host: hostOf(step.url) })}
            />
            <div className="flex items-center justify-end gap-3">
              <button type="button" className={textButton} onClick={() => void cancel(step.url)}>
                {t("entry.desktop.waiting.cancel")}
              </button>
              <button type="button" className={secondaryButton} onClick={() => void begin(step.url)}>
                {t("entry.desktop.waiting.openAgain")}
              </button>
            </div>
          </>
        )}
      </div>
    </EntryColumn>
  );
}
