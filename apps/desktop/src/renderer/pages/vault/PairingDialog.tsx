import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  cancelPairingNow,
  useCancelPairing,
  usePairingResult,
  useStartPairing,
} from "../../data/queries";
import { isAppBuild } from "../../data/build";
import { Dialog } from "../../tasks-ui/Dialog";
import { primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { PairingPrototype } from "./VaultPrototype";

// La finestra dell'associazione (shape `vault.md` §3 «Pair this Mac», [VA 8]):
// un dialogo, tre momenti. Si apre e chiede l'accoppiamento (il main apre il
// browser); mostra l'impronta grande e i tre passi — il secondo dice di
// SCRIVERE nel browser gli ultimi 4 caratteri (M3 della seconda revisione:
// la pagina del browser non mostra l'impronta) —, poi l'esito dal ritorno
// del browser: riuscita (la cassaforte è già aperta, D-1b) o fallita in
// parola con «Try again». Chiudere durante l'attesa dimentica la richiesta.

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; fingerprint: string }
  | { kind: "done" }
  | { kind: "failed"; code: string };

const KNOWN = [
  "expired",
  "open_failed",
  "no_secure_storage",
  "session_changed",
  "vault_key_not_confirmed",
];

export function PairingDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const start = useStartPairing();
  const cancel = useCancelPairing();
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const waiting = useRef(false);
  waiting.current = phase.kind === "waiting";
  // Review M6: chiuso mentre la richiesta è ancora in volo; quando torna,
  // l'associazione appena aperta si annulla.
  const closed = useRef(false);

  const begin = async () => {
    setPhase({ kind: "starting" });
    const out = await start.mutateAsync(undefined).catch(() => null);
    if (closed.current) {
      // Il dialogo è già smontato: la mutazione non partirebbe più.
      if (out?.ok) void cancelPairingNow().catch(() => null);
      return;
    }
    if (out?.ok) setPhase({ kind: "waiting", fingerprint: out.fingerprint });
    else setPhase({ kind: "failed", code: out && !out.ok ? out.code : "other" });
  };

  useEffect(() => {
    void begin();
    // Una volta all'apertura; «Try again» ricomincia da sé.
  }, []);

  // Quarta revisione, punto 6: anche uno smontaggio (si cambia pagina col
  // dialogo aperto) annulla, come Cancel. Rimesso a `false` al montaggio, per
  // il doppio effetto di StrictMode in sviluppo.
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      if (waiting.current) void cancelPairingNow().catch(() => null);
    };
  }, []);

  usePairingResult((result) => {
    if (!waiting.current) return;
    setPhase(result.ok ? { kind: "done" } : { kind: "failed", code: result.code });
  });

  const close = () => {
    closed.current = true;
    if (waiting.current) void cancel.mutateAsync(undefined).catch(() => null);
    onClose();
  };

  const last4 = phase.kind === "waiting" ? phase.fingerprint.replace(/\s/g, "").slice(-4) : "";

  return (
    <Dialog
      title={t("vault.pairing.title")}
      description={t("vault.pairing.intro")}
      onClose={close}
      footer={
        phase.kind === "done" ? (
          <button type="button" className={primaryButton} onClick={onClose}>
            {t("vault.pairing.done")}
          </button>
        ) : phase.kind === "failed" ? (
          <>
            <button type="button" className={quietButton} onClick={onClose}>
              {t("vault.pairing.cancel")}
            </button>
            <button type="button" className={secondaryButton} onClick={() => void begin()}>
              {t("vault.pairing.retry")}
            </button>
          </>
        ) : (
          <button type="button" className={quietButton} onClick={close}>
            {t("vault.pairing.cancel")}
          </button>
        )
      }
    >
      {phase.kind === "starting" && (
        <p className="text-sm text-ink-muted">{t("vault.pairing.starting")}</p>
      )}
      {phase.kind === "waiting" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm text-ink-muted">{t("vault.pairing.key")}</span>
            <span
              data-testid="pairing-fingerprint"
              className="font-mono text-2xl tabular-nums tracking-wide text-ink"
            >
              {phase.fingerprint}
            </span>
          </div>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-md text-ink">
            <li>{t("vault.pairing.step1")}</li>
            <li>{t("vault.pairing.step2", { last4 })}</li>
            <li>{t("vault.pairing.step3")}</li>
          </ol>
          {!isAppBuild() && <PairingPrototype />}
          <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
            <span
              aria-hidden="true"
              className="size-3 animate-spin rounded-full border-2 border-ink-faint border-t-ink"
            />
            {t("vault.pairing.waiting")}
          </p>
        </div>
      )}
      {phase.kind === "done" && (
        <p role="status" className="flex items-center gap-2 text-md text-ink">
          <span aria-hidden="true" className="text-positive">
            ✓
          </span>
          {t("vault.pairing.success")}
        </p>
      )}
      {phase.kind === "failed" && (
        <p role="alert" className="text-md text-ink">
          {t(`vault.pairing.errors.${KNOWN.includes(phase.code) ? phase.code : "other"}`)}
        </p>
      )}
    </Dialog>
  );
}
