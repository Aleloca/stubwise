import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { postVaultActivate } from "../api";
import { vaultStatusQueryOptions } from "../queries";
import { startIdleTimer, VAULT_IDLE_MS } from "./idle";
import { hasLiveKey, unlockVault, type UnlockedKey } from "./unlock";

/**
 * La cassaforte nella scheda (design «Il modello delle chiavi»).
 *
 * - `inactive`: non attivata sull'istanza (o stato non ancora letto);
 * - `no_key`: attiva, ma la persona non ha una chiave viva — lo sblocco la crea;
 * - `locked`: ha una chiave, chiusa;
 * - `unlocked`: chiave privata aperta, in memoria;
 * - `unsupported`: l'ultimo tentativo ha usato una passkey senza PRF; nessuna
 *   chiave è stata creata, serve una passkey compatibile.
 */
export type VaultState = "inactive" | "locked" | "unlocked" | "no_key" | "unsupported";

export interface VaultContextValue {
  state: VaultState;
  /** Apre (o, alla prima volta, crea) la chiave con una passkey. Rifiuta con `VaultError`/`ApiError`. */
  unlock(): Promise<void>;
  lock(): void;
  /** La chiave privata della persona, NON estraibile. Solo qui, mai nello storage del browser. */
  privateKey: CryptoKey | null;
  personKeyId: string | null;
  /**
   * La pubblica della chiave aperta, verificata contro la privata (il sigillo
   * è legato alla pubblica): da qui la propria impronta (`keyFingerprint`).
   */
  publicKey: string | null;
  /**
   * Attivazione (full admin, `routes/vault-setup.tsx`): passkey con PRF,
   * poi `POST /activate` con la chiave pubblica di recupero, poi la chiave
   * dell'admin. Senza PRF si ferma PRIMA di attivare (stato `unsupported`).
   */
  activate(recoveryPublicKey: string): Promise<void>;
  /**
   * Ricrea la chiave quando nessuna passkey la apre più (errore `no_seal`):
   * la vecchia è sostituita, le credenziali della persona tornano «in
   * attesa» e la nuova va confermata. Solo su richiesta esplicita.
   */
  recreateKey(): Promise<void>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

/**
 * Tiene la chiave privata SOLO nello stato React di questo provider:
 * nessuno storage del browser (né localStorage, né sessionStorage, né
 * IndexedDB). Si perde da sola chiudendo la scheda; si butta con `lock()`,
 * dopo {@link VAULT_IDLE_MS} senza interazioni e allo smontaggio — il
 * provider sta nel layout autenticato, che si smonta al logout.
 */
export function VaultProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: status } = useQuery({ ...vaultStatusQueryOptions, retry: false });
  const [key, setKey] = useState<UnlockedKey | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  const lock = useCallback(() => setKey(null), []);

  // Inattività: il conto parte quando si apre e si ferma quando si chiude.
  useEffect(() => {
    if (!key) return undefined;
    return startIdleTimer(lock, VAULT_IDLE_MS);
  }, [key, lock]);

  const run = useCallback(
    async (beforeKey?: () => Promise<void>, mode: "open" | "recreate" = "open") => {
      // Stato fresco: chiave e sigilli possono essere cambiati da un'altra scheda.
      const fresh = await queryClient.fetchQuery({ ...vaultStatusQueryOptions, staleTime: 0 });
      try {
        const result = await unlockVault(fresh, beforeKey, mode);
        if (result.kind === "unsupported") {
          setKey(null);
          setUnsupported(true);
          return;
        }
        setUnsupported(false);
        setKey({ privateKey: result.privateKey, personKeyId: result.personKeyId, publicKey: result.publicKey });
      } finally {
        // Una chiave creata (o la cassaforte attivata) cambia lo stato.
        await queryClient.invalidateQueries({ queryKey: vaultStatusQueryOptions.queryKey });
      }
    },
    [queryClient],
  );

  const unlock = useCallback(() => run(), [run]);
  const activate = useCallback(
    (recoveryPublicKey: string) => run(() => postVaultActivate(recoveryPublicKey)),
    [run],
  );
  const recreateKey = useCallback(() => run(undefined, "recreate"), [run]);

  const value = useMemo<VaultContextValue>(() => {
    let state: VaultState;
    if (key) state = "unlocked";
    else if (unsupported) state = "unsupported";
    else if (!status?.activated) state = "inactive";
    else state = hasLiveKey(status) ? "locked" : "no_key";
    return {
      state,
      unlock,
      lock,
      activate,
      recreateKey,
      privateKey: key?.privateKey ?? null,
      personKeyId: key?.personKeyId ?? null,
      publicKey: key?.publicKey ?? null,
    };
  }, [key, unsupported, status, unlock, lock, activate, recreateKey]);

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

/**
 * La cassaforte della scheda, o `null` fuori dal `VaultProvider`: per i pezzi
 * che compaiono anche dove la cassaforte non è montata (Impostazioni →
 * Sicurezza nei test) e lì semplicemente non si mostrano.
 */
export function useOptionalVault(): VaultContextValue | null {
  return useContext(VaultContext);
}

/** La cassaforte della scheda. Fuori dal `VaultProvider` lancia: è un errore di montaggio. */
export function useVault(): VaultContextValue {
  const value = useContext(VaultContext);
  if (!value) throw new Error("useVault fuori da VaultProvider");
  return value;
}
