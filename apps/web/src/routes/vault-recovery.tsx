import { openRecoveryChallenge, parseRecoveryKit } from "@stubwise/vault-crypto";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { actionPrimaryClass } from "../components/backlog/modal";
import { PendingPeople, type ConfirmOutcome } from "../components/vault/pending-access";
import { vaultErrorMessage } from "../components/vault/unlock-dialog";
import {
  ApiError,
  postVaultRecoveryChallenge,
  postVaultRecoveryConfirm,
  postVaultRecoveryPending,
  type VaultPendingPerson,
} from "../lib/api";
import { rewrapForPerson } from "../lib/vault/credentials";

/** Prova di possesso del kit: la sfida e il suo segreto, aperto nel browser. */
interface Proof {
  challengeId: string;
  proof: string;
}

/** Il kit non apre la sfida: è un kit, ma non quello della cassaforte. */
class WrongKitError extends Error {}

/**
 * Recupero col kit (Impostazioni → Cassaforte → «Usa il kit di recupero»,
 * solo full admin con riconferma recente: la guardia è nel router, le
 * autorità sono il server e le sue sfide). Design «Kit di recupero».
 *
 * Il testo del kit si incolla, `parseRecoveryKit` ne ricava la privata (NON
 * estraibile) e il testo esce subito dallo stato. Al server non va MAI: gli
 * va solo la prova, il segreto di una sfida aperta col kit. La privata vive
 * nello stato di questa pagina e si butta con «Ho finito» o lasciando la
 * pagina (smontaggio); nessuno storage del browser.
 *
 * Il kit serve SOLO a confermare accessi in attesa (stessa schermata della
 * conferma normale, senza «Rifiuta»): apre la copia di recupero di ogni
 * credenziale e la ricifra per la persona. Non mostra mai una password. Ogni
 * conferma consuma la sua sfida: la prova di un elenco (che non la consuma)
 * vale per UNA conferma, poi se ne chiede una nuova.
 */
export function VaultRecoveryPage() {
  const { t } = useTranslation();
  const [kitText, setKitText] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<CryptoKey | null>(null);
  const [items, setItems] = useState<VaultPendingPerson[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Una prova non ancora consumata (l'ha vista solo l'elenco), o nessuna. */
  const unusedProof = useRef<Proof | null>(null);

  // Lasciando la pagina la prova pendente si butta con lo stato.
  useEffect(
    () => () => {
      unusedProof.current = null;
    },
    [],
  );

  async function prove(key: CryptoKey): Promise<Proof> {
    const { challengeId, wrapped } = await postVaultRecoveryChallenge();
    try {
      return { challengeId, proof: await openRecoveryChallenge(wrapped, key, challengeId) };
    } catch {
      throw new WrongKitError();
    }
  }

  /** Rilegge l'elenco con una sfida nuova, che resta buona per la prossima conferma. */
  async function reload(key: CryptoKey) {
    const proof = await prove(key);
    const list = await postVaultRecoveryPending(proof);
    unusedProof.current = proof;
    setItems(list.items ?? []);
  }

  async function applyKit() {
    setError(null);
    let key: CryptoKey;
    try {
      key = await parseRecoveryKit(kitText);
    } catch {
      setError(t("vault:recovery.invalidKit"));
      return;
    }
    // Letto: il testo esce dallo stato, resta solo la privata non estraibile.
    setKitText("");
    setBusy(true);
    try {
      await reload(key);
      setRecoveryKey(key);
    } catch (cause) {
      setError(cause instanceof WrongKitError ? t("vault:recovery.wrongKit") : vaultErrorMessage(cause, t));
    } finally {
      setBusy(false);
    }
  }

  function forget() {
    unusedProof.current = null;
    setRecoveryKey(null);
    setItems(null);
    setKitText("");
    setError(null);
  }

  async function confirm(person: VaultPendingPerson): Promise<ConfirmOutcome | null> {
    if (!recoveryKey) return null;
    const { copies, failed } = await rewrapForPerson(
      person.credentials ?? [],
      { privateKey: recoveryKey, recipientId: "recovery" },
      { personKeyId: person.personKey.id, publicKey: person.personKey.fingerprintSource },
    );
    const send = async (proof: Proof) =>
      postVaultRecoveryConfirm(person.personKey.id, { ...proof, copies });
    const first = unusedProof.current ?? (await prove(recoveryKey));
    unusedProof.current = null;
    let result;
    try {
      result = await send(first);
    } catch (cause) {
      // La sfida dell'elenco vale 5 minuti: scaduta, se ne chiede una nuova, una volta.
      if (!(cause instanceof ApiError && cause.code === "recovery_proof_invalid")) throw cause;
      result = await send(await prove(recoveryKey));
    }
    await reload(recoveryKey);
    return { result, failed };
  }

  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold">{t("vault:recovery.title")}</h2>
        <p className="mt-1 text-sm text-fg-muted">{t("vault:recovery.subtitle")}</p>
      </header>

      {recoveryKey && items ? (
        <div className="flex flex-col gap-3">
          {items.length === 0 ? (
            <p className="text-sm">{t("vault:recovery.empty")}</p>
          ) : (
            <>
              <p className="text-sm">{t("vault:recovery.loaded")}</p>
              <p className="text-sm text-fg-muted">{t("vault:pending.intro")}</p>
            </>
          )}
          <PendingPeople items={items} onConfirm={confirm} />
          <button
            type="button"
            onClick={forget}
            className="self-start rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[12px] tracking-[0.08em] text-fg uppercase transition-colors hover:border-signal-dim"
          >
            {t("vault:recovery.done")}
          </button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void applyKit();
          }}
        >
          <label htmlFor="vault-recovery-kit" className="text-sm font-medium">
            {t("vault:recovery.kitLabel")}
          </label>
          <textarea
            id="vault-recovery-kit"
            value={kitText}
            onChange={(event) => setKitText(event.target.value)}
            aria-describedby="vault-recovery-kit-hint"
            autoComplete="off"
            spellCheck={false}
            rows={5}
            className="rounded-sm border border-line bg-ink-950/70 px-3 py-2 font-mono text-[13px] text-fg"
          />
          <p id="vault-recovery-kit-hint" className="text-[12px] text-fg-muted">
            {t("vault:recovery.kitHint")}
          </p>
          <button
            type="submit"
            disabled={busy || kitText.trim() === ""}
            className={`${actionPrimaryClass} self-start`}
          >
            {busy ? t("vault:recovery.using") : t("vault:recovery.use")}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
