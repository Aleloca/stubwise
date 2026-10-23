import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { generateRecoveryKit } from "@stubwise/vault-crypto";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { actionPrimaryClass } from "../components/backlog/modal";
import { RecoveryKitPanel } from "../components/vault/recovery-kit";
import {
  UnlockDialog,
  vaultErrorMessage,
  VaultUnsupportedNotice,
} from "../components/vault/unlock-dialog";
import { ApiError, getVaultStatus } from "../lib/api";
import { vaultStatusQueryOptions } from "../lib/queries";
import { useVault } from "../lib/vault/vault-context";

/** Il kit appena generato: la privata (testo) resta solo qui, la pubblica va al server. */
interface Kit {
  publicKey: string;
  kitText: string;
}

/**
 * Attivazione della cassaforte e kit di recupero (Impostazioni → Cassaforte,
 * solo full admin: la guardia è nel router, l'autorità resta il server).
 *
 * Il flusso, in ordine: si genera il kit nel browser; si mostra UNA volta e
 * si prosegue solo dopo «Ho stampato/salvato il kit»; poi la passkey con PRF
 * (senza PRF ci si ferma qui, prima di attivare: nessuna cassaforte attiva
 * con un admin senza chiave), `POST /activate` con la sola chiave pubblica di
 * recupero, e la chiave personale dell'admin, nello stesso giro. Il testo del
 * kit si butta appena la cassaforte è aperta.
 */
export function VaultSetupPage() {
  const { t } = useTranslation();
  const vault = useVault();
  const status = useQuery({ ...vaultStatusQueryOptions, retry: false });
  const [kit, setKit] = useState<Kit | null>(null);
  const [generating, setGenerating] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // La `POST /activate` è andata (ma la chiave no): riprovare apre soltanto.
  const [activatedByUs, setActivatedByUs] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);

  async function generate() {
    setError(null);
    setGenerating(true);
    try {
      setKit(await generateRecoveryKit());
    } finally {
      setGenerating(false);
    }
  }

  async function confirm(current: Kit) {
    setError(null);
    setPending(true);
    try {
      if (activatedByUs) await vault.unlock();
      else await vault.activate(current.publicKey);
      // Il kit si mostra una volta: aperta la cassaforte — o fermati per una
      // passkey senza PRF, PRIMA di attivare — il testo sparisce dallo stato.
      setKit(null);
    } catch (cause) {
      setError(vaultErrorMessage(cause, t));
      if (cause instanceof ApiError && cause.code === "vault_already_active") {
        // Attivata da qualcun altro nel frattempo: questo kit non vale niente.
        setKit(null);
      } else {
        // Se l'attivazione è passata e si è fermata dopo, il kit è QUELLO
        // giusto: resta in vista, e il prossimo tentativo apre soltanto.
        const fresh = await getVaultStatus().catch(() => null);
        if (fresh?.activated) setActivatedByUs(true);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold">{t("vault:setup.title")}</h2>
        <p className="mt-1 text-sm text-fg-muted">{t("vault:setup.subtitle")}</p>
      </header>

      {kit ? (
        <>
          <RecoveryKitPanel
            kitText={kit.kitText}
            continueLabel={pending ? t("vault:setup.activating") : t("vault:setup.activate")}
            pending={pending}
            onConfirm={() => void confirm(kit)}
          />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </>
      ) : status.data?.activated ? (
        <ActiveVault onOpen={() => setUnlockOpen(true)} />
      ) : status.data ? (
        <div className="flex flex-col gap-3">
          {vault.state === "unsupported" && <VaultUnsupportedNotice />}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <p className="text-sm">{t("vault:setup.intro")}</p>
          <p className="text-sm text-fg-muted">{t("vault:setup.warning")}</p>
          <button
            type="button"
            onClick={() => void generate()}
            disabled={generating}
            className={`${actionPrimaryClass} self-start`}
          >
            {t("vault:setup.generate")}
          </button>
        </div>
      ) : null}

      {unlockOpen && <UnlockDialog onClose={() => setUnlockOpen(false)} />}
    </section>
  );
}

/** La cassaforte è già attiva: lo stato della propria chiave nella scheda. */
function ActiveVault({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const vault = useVault();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">{t("vault:setup.active")}</p>
      {vault.state === "unsupported" && <VaultUnsupportedNotice />}
      {vault.state === "unlocked" ? (
        <p className="text-sm text-ok">{t("vault:setup.unlocked")}</p>
      ) : (
        <button type="button" onClick={onOpen} className={`${actionPrimaryClass} self-start`}>
          {vault.state === "no_key" ? t("vault:setup.createKey") : t("vault:unlock.action")}
        </button>
      )}
      <Link to="/settings/vault/recovery" className="self-start text-sm text-signal underline">
        {t("vault:recovery.link")}
      </Link>
    </div>
  );
}
