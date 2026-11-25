import { useEffect, useState } from "react";
import { useVaultChanges, useVaultLock } from "../../data/queries";
import { PairingDialog } from "./PairingDialog";
import { useOpenVault } from "./VaultBar";

// I comandi ⌘K della cassaforte che AGISCONO (shape `vault.md` §3): «Open the
// vault» (Touch ID, da qualunque pagina), «Lock the vault», «Pair this Mac».
// La palette li chiede con `runVaultCommand`, come `openLinkFolder`; questo
// host, montato dal layout, li fa con gli stessi hook della barra.

export type VaultCommand = "open" | "lock" | "pair";
const listeners = new Set<(command: VaultCommand) => void>();

export function runVaultCommand(command: VaultCommand): void {
  for (const l of listeners) l(command);
}

export function VaultCommandHost() {
  const { open } = useOpenVault();
  const lock = useVaultLock();
  const [pairing, setPairing] = useState(false);
  // Il main dice quando la cassaforte cambia da sé: la barra si rilegge.
  useVaultChanges();
  useEffect(() => {
    const listener = (command: VaultCommand) => {
      if (command === "open") void open();
      else if (command === "lock") lock.mutate(undefined);
      else setPairing(true);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [open, lock]);
  return pairing ? <PairingDialog onClose={() => setPairing(false)} /> : null;
}
