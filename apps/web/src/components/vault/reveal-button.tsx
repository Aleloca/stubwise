import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CLIPBOARD_CLEAR_MS, copyWithAutoClear, revealPassword } from "../../lib/vault/credentials";
import { useVault } from "../../lib/vault/vault-context";
import { UnlockDialog, vaultErrorMessage } from "./unlock-dialog";

const buttonClass =
  "tap rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Esegue `run` con la cassaforte aperta: se è chiusa apre prima il dialogo
 * della passkey e riprende l'azione quando si apre (annullare il dialogo
 * annulla l'azione). La chiave privata la legge da `useVault` al momento
 * dell'esecuzione, mai copiata altrove.
 */
export function useWithUnlockedVault() {
  const vault = useVault();
  const [waiting, setWaiting] = useState<
    ((key: { privateKey: CryptoKey; personKeyId: string }) => void) | null
  >(null);

  useEffect(() => {
    if (!waiting || vault.state !== "unlocked" || !vault.privateKey || !vault.personKeyId) return;
    const action = waiting;
    setWaiting(null);
    action({ privateKey: vault.privateKey, personKeyId: vault.personKeyId });
  }, [waiting, vault.state, vault.privateKey, vault.personKeyId]);

  const run = useCallback(
    (action: (key: { privateKey: CryptoKey; personKeyId: string }) => void) => {
      if (vault.state === "unlocked" && vault.privateKey && vault.personKeyId) {
        action({ privateKey: vault.privateKey, personKeyId: vault.personKeyId });
        return;
      }
      // Funzione nello stato: va avvolta, o React la chiamerebbe come updater.
      setWaiting(() => action);
    },
    [vault.state, vault.privateKey, vault.personKeyId],
  );

  const cancel = useCallback(() => setWaiting(null), []);
  const dialog = waiting && vault.state !== "unlocked" ? <UnlockDialog onClose={cancel} /> : null;
  return { run, dialog };
}

/**
 * «Mostra» e «Copia» di UNA credenziale (design «Mostrare e copiare»). La
 * password in chiaro vive solo nello stato di questo componente mentre è
 * mostrata: sparisce con «Nascondi», dopo 30 secondi, quando la cassaforte
 * si chiude e allo smontaggio. Copiata, va negli appunti (svuotati dopo 30
 * secondi) e non resta qui.
 */
export function RevealButtons({ credentialId, name }: { credentialId: string; name: string }) {
  const { t } = useTranslation();
  const vault = useVault();
  const { run, dialog } = useWithUnlockedVault();
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setShown(null);
  }, []);

  // Cassaforte chiusa (a mano, per inattività, al logout): la password sparisce.
  useEffect(() => {
    if (vault.state !== "unlocked") hide();
  }, [vault.state, hide]);
  useEffect(() => hide, [hide]);

  function act(action: "show" | "copy") {
    setMessage(null);
    run(({ privateKey }) => {
      setBusy(true);
      void (async () => {
        try {
          const password = await revealPassword(credentialId, action, privateKey);
          if (action === "show") {
            if (hideTimer.current) clearTimeout(hideTimer.current);
            hideTimer.current = setTimeout(hide, CLIPBOARD_CLEAR_MS);
            setShown(password);
            return;
          }
          try {
            await copyWithAutoClear(password);
            setMessage({ kind: "info", text: t("vault:credentials.copied") });
          } catch {
            setMessage({ kind: "error", text: t("vault:credentials.copyFailed") });
          }
        } catch (cause) {
          setMessage({
            kind: "error",
            text:
              cause instanceof DOMException
                ? t("vault:credentials.revealFailed")
                : vaultErrorMessage(cause, t),
          });
        } finally {
          setBusy(false);
        }
      })();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="flex flex-wrap items-center justify-end gap-2">
        {shown !== null ? (
          <>
            <code
              aria-label={t("vault:credentials.passwordOf", { name })}
              className="rounded-sm border border-line bg-ink-950 px-2 py-0.5 font-mono text-[12px] break-all text-fg select-all"
            >
              {shown}
            </code>
            <button
              type="button"
              onClick={hide}
              aria-label={t("vault:credentials.hideAria", { name })}
              className={buttonClass}
            >
              {t("vault:credentials.hide")}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => act("show")}
            disabled={busy}
            aria-label={t("vault:credentials.showAria", { name })}
            className={buttonClass}
          >
            {t("vault:credentials.show")}
          </button>
        )}
        <button
          type="button"
          onClick={() => act("copy")}
          disabled={busy}
          aria-label={t("vault:credentials.copyAria", { name })}
          className={buttonClass}
        >
          {t("vault:credentials.copy")}
        </button>
      </span>
      {message && (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={`font-mono text-[11px] ${message.kind === "error" ? "text-danger" : "text-fg-faint"}`}
        >
          {message.text}
        </p>
      )}
      {dialog}
    </div>
  );
}
