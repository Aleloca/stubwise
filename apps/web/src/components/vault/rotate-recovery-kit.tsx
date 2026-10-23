import { generateRecoveryKit } from "@stubwise/vault-crypto";
import type { VaultRecoveryKeyPreview } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, getVaultRecoveryKeyPreview, postVaultRecoveryKey } from "../../lib/api";
import { proveKey, recoveryKitCopies, type OpenKey } from "../../lib/vault/credentials";
import { actionButtonClass } from "../backlog/modal";
import { RecoveryKitPanel } from "./recovery-kit";
import { useWithUnlockedVault } from "./reveal-button";
import { vaultErrorMessage } from "./unlock-dialog";

type Missing = VaultRecoveryKeyPreview["missing"];

/**
 * Rigenerazione del kit di recupero (Impostazioni → Cassaforte, full admin,
 * con la cassaforte aperta). Design «Kit di recupero», review finale D.
 *
 * In ordine: l'anteprima del server dà la PROPRIA copia di ogni credenziale;
 * se ne manca anche una la rotazione non si fa (le vuole tutte: la
 * credenziale senza copia resterebbe leggibile solo col kit vecchio) e la
 * pagina dice quali. Altrimenti il kit nuovo nasce nel browser e si mostra
 * UNA volta; dopo «Ho stampato/salvato il nuovo kit» ogni chiave d'oggetto si
 * ricifra per la pubblica nuova, e al server vanno pubblica, copie e la prova
 * della propria chiave. Il kit vecchio smette di valere. Su 409
 * `recipients_changed` (una credenziale creata o tolta nel frattempo) si
 * rilegge l'anteprima e si riprova UNA volta con lo stesso kit.
 */
export function RotateRecoveryKit() {
  const { t } = useTranslation();
  const { run, dialog } = useWithUnlockedVault();
  const [kit, setKit] = useState<{ publicKey: string; kitText: string } | null>(null);
  const [missing, setMissing] = useState<Missing>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [openKey, setOpenKey] = useState<OpenKey | null>(null);

  /** L'anteprima; con credenziali senza copia si ferma e le elenca. */
  async function loadPreview(): Promise<VaultRecoveryKeyPreview | null> {
    const preview = await getVaultRecoveryKeyPreview();
    const lacking = preview.missing ?? [];
    setMissing(lacking);
    return lacking.length > 0 ? null : preview;
  }

  function start() {
    setError(null);
    setDone(false);
    setMissing([]);
    run((key) => {
      setBusy(true);
      void (async () => {
        try {
          if (!(await loadPreview())) return;
          setOpenKey(key);
          setKit(await generateRecoveryKit());
        } catch (cause) {
          setError(vaultErrorMessage(cause, t));
        } finally {
          setBusy(false);
        }
      })();
    });
  }

  async function replace(current: { publicKey: string }, key: OpenKey) {
    setError(null);
    setBusy(true);
    try {
      const attempt = async () => {
        const preview = await loadPreview();
        if (!preview) return false;
        const copies = await recoveryKitCopies(preview, key, current.publicKey);
        await postVaultRecoveryKey({
          recoveryPublicKey: current.publicKey,
          copies,
          actorProof: await proveKey(key),
        });
        return true;
      };
      let ok: boolean;
      try {
        ok = await attempt();
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.code === "recipients_changed")) throw cause;
        ok = await attempt();
      }
      if (!ok) {
        setKit(null);
        return;
      }
      // Il kit nuovo è al sicuro e in uso: il testo sparisce dalla pagina.
      setKit(null);
      setOpenKey(null);
      setDone(true);
    } catch (cause) {
      setError(vaultErrorMessage(cause, t));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setKit(null);
    setOpenKey(null);
    setError(null);
  }

  return (
    <section aria-label={t("vault:rotate.title")} className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">{t("vault:rotate.title")}</h3>
      {kit && openKey ? (
        <>
          <p role="note" className="rounded-sm border border-danger/40 bg-danger/10 p-3 text-sm text-fg">
            {t("vault:rotate.warning")}
          </p>
          <RecoveryKitPanel
            kitText={kit.kitText}
            savedLabel={t("vault:rotate.saved")}
            continueLabel={busy ? t("vault:rotate.replacing") : t("vault:rotate.replace")}
            pending={busy}
            onConfirm={() => void replace(kit, openKey)}
          />
          <button type="button" className={`${actionButtonClass} self-start`} disabled={busy} onClick={cancel}>
            {t("vault:rotate.cancel")}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-fg-muted">{t("vault:rotate.intro")}</p>
          <button type="button" className={`${actionButtonClass} self-start`} disabled={busy} onClick={start}>
            {t("vault:rotate.action")}
          </button>
        </>
      )}
      {done && (
        <p role="status" className="text-sm text-ok">
          {t("vault:rotate.done")}
        </p>
      )}
      {missing.length > 0 && (
        <div role="alert" className="flex flex-col gap-1 rounded-sm border border-danger/40 bg-danger/10 p-3 text-sm">
          <p>{t("vault:rotate.missing")}</p>
          <ul className="list-disc pl-5 font-mono text-[12px]">
            {missing.map((credential) => (
              <li key={credential.id}>
                {credential.label ? `${credential.service} · ${credential.label}` : credential.service}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {dialog}
    </section>
  );
}
