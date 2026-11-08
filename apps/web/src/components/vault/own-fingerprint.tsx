import { useQuery } from "@tanstack/react-query";
import { keyFingerprint } from "@stubwise/vault-crypto";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { vaultStatusQueryOptions } from "../../lib/queries";
import { hasLiveKey } from "../../lib/vault/unlock";
import { useOptionalVault } from "../../lib/vault/vault-context";
import { UnlockDialog } from "./unlock-dialog";

/** L'impronta di una chiave pubblica, calcolata nel browser (`keyFingerprint`). */
export function useFingerprint(publicKey: string | null | undefined): string | null {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setFingerprint(null);
    if (!publicKey) return undefined;
    keyFingerprint(publicKey).then(
      (value) => alive && setFingerprint(value),
      () => alive && setFingerprint(null),
    );
    return () => {
      alive = false;
    };
  }, [publicKey]);
  return fingerprint;
}

/**
 * La PROPRIA impronta, da confrontare con chi conferma la chiave (stesso
 * formato di «Accessi da confermare»). Si calcola dalla pubblica che la
 * scheda tiene in memoria dopo lo sblocco, già verificata contro la privata
 * (il sigillo è legato alla pubblica): non da una risposta del server presa
 * sulla parola. A cassaforte chiusa propone di aprirla. Fuori dal
 * `VaultProvider`, o senza una chiave viva, non c'è.
 */
export function OwnKeyFingerprint() {
  const { t } = useTranslation();
  const vault = useOptionalVault();
  const { data: status } = useQuery({ ...vaultStatusQueryOptions, retry: false });
  const unlocked = vault?.state === "unlocked" ? vault.publicKey : null;
  const fingerprint = useFingerprint(unlocked);
  const [open, setOpen] = useState(false);
  if (!vault || !status?.activated || !hasLiveKey(status)) return null;
  if (unlocked) {
    return (
      <p className="text-[13px]">
        <span className="text-fg-muted">{t("vault:own.fingerprint")}</span>{" "}
        <span data-testid="own-key-fingerprint" className="font-mono">
          {fingerprint ?? "…"}
        </span>
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <p className="text-fg-muted">{t("vault:own.locked")}</p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.08em] text-fg uppercase transition-colors hover:border-signal-dim"
      >
        {t("vault:unlock.action")}
      </button>
      {open && <UnlockDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
