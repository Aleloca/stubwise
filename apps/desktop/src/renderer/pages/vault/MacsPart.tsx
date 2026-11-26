import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForgetThisMac, useMyMacs, useRemoveMac, useVaultStatus } from "../../data/queries";
import type { MacView } from "../../data/vault/types";
import { useReauth } from "../../layout/useReauth";
import { useToast } from "../../tasks-ui/Toast";
import { Part } from "../preferences/parts";
import { dangerSolidButton, quietButton, secondaryButton } from "../tasks/controls";
import { PairingDialog } from "./PairingDialog";
import { useOpenVault } from "./VaultBar";

// Preferenze → Security, «Macs that open the vault» (shape `vault.md` §3,
// sotto «Passkeys», sopra «Open sessions»): i propri Mac con l'impronta
// INTERA (un'impronta troncata non si confronta, M7) e «this Mac» sul
// corrente. «Forget this Mac» a due tempi in posto; «Remove» di un altro
// proprio Mac da qui (VA-Q4, maintainer) con la cassaforte aperta (la prova
// della propria chiave) E la riconferma, nell'ordine del server [VA 9].

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function MacsPart() {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const status = useVaultStatus().data;
  const macs = useMyMacs().data;
  const forget = useForgetThisMac();
  const remove = useRemoveMac();
  const { open } = useOpenVault();
  const [asking, setAsking] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);

  // Solo con la cassaforte dell'istanza attiva.
  if (!status || status.state === "inactive" || !macs) return null;

  const onForget = async () => {
    setAsking(null);
    const out = await forget.mutateAsync(undefined).catch(() => null);
    if (!out?.ok) return void toast.error(t("vault.macs.failed"));
    toast.show(out.remote ? t("vault.macs.forgotten") : t("vault.macs.forgottenLocal"));
  };

  const onRemove = async (mac: MacView) => {
    setAsking(null);
    // La prova della propria chiave: prima la cassaforte aperta (Touch ID).
    if (status.state !== "open" && !(await open())) return;
    const out = await reauth(
      async () => {
        const r = await remove.mutateAsync(mac.id);
        // La cassaforte dice `code`; la riconferma riconosce `error`.
        return !r.ok && r.code === "reauth_required"
          ? ({ ok: false, error: "reauth_required" } as const)
          : r;
      },
      { action: t("vault.macs.reauth") },
    ).catch(() => null);
    if (out && "error" in out && out.error === "reauth_cancelled") return;
    if (!out?.ok) return void toast.error(t("vault.macs.failed"));
    toast.show(t("vault.macs.removed"));
  };

  return (
    <Part title={t("vault.macs.title")}>
      {pairing && <PairingDialog onClose={() => setPairing(false)} />}
      <p className="text-md text-ink-muted">{t("vault.macs.intro")}</p>
      {macs.length === 0 ? (
        <div className="mt-3 flex items-center gap-3">
          <p className="flex-1 text-md text-ink-muted">{t("vault.macs.empty")}</p>
          <button type="button" className={secondaryButton} onClick={() => setPairing(true)}>
            {t("vault.macs.pair")}
          </button>
        </div>
      ) : (
        <ul className="mt-3 flex flex-col border-t border-rule">
          {macs.map((mac) => (
            <li key={mac.id} className="flex flex-col gap-2 border-b border-rule py-2">
              <div className="flex min-h-10 items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-baseline gap-2 text-md text-ink">
                    <span className="truncate">{mac.name}</span>
                    {mac.current && (
                      <span className="text-sm text-ink-muted">{t("vault.macs.thisMac")}</span>
                    )}
                  </span>
                  <span className="text-sm text-ink-muted">
                    {mac.lastUsedAt
                      ? t("vault.macs.paired", {
                          paired: day(mac.pairedAt),
                          used: day(mac.lastUsedAt),
                        })
                      : t("vault.macs.pairedNever", { paired: day(mac.pairedAt) })}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-ink-muted">
                    {mac.fingerprint}
                  </span>
                </div>
                {asking !== mac.id && (
                  <button type="button" className={quietButton} onClick={() => setAsking(mac.id)}>
                    {mac.current ? t("vault.macs.forget") : t("vault.macs.remove")}
                  </button>
                )}
              </div>
              {asking === mac.id && (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-sm text-ink">
                    {mac.current ? t("vault.macs.forgetQuestion") : t("vault.macs.removeQuestion")}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={dangerSolidButton}
                      onClick={() => void (mac.current ? onForget() : onRemove(mac))}
                    >
                      {mac.current
                        ? t("vault.macs.forgetYes")
                        : t("vault.macs.removeYes", { name: mac.name })}
                    </button>
                    <button type="button" className={quietButton} onClick={() => setAsking(null)}>
                      {t("vault.macs.cancel")}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Part>
  );
}
