import { useEffect, useState } from "react";
import { useVaultUsable } from "./useVaultUsable";
import { useTranslation } from "react-i18next";
import { useCopyPassword, useOnVaultChange, useShowPassword, useVaultStatus } from "../../data/queries";
import { isWebAppBuild } from "../../platform/vaultBridge";
import { useToast } from "../../tasks-ui/Toast";
import { useOpenVault } from "./VaultBar";

// Mostrare, nascondere e copiare una password (shape `vault.md` §3), le
// stesse regole nelle righe e nel pannello di dettaglio: la password
// mostrata sta SOLO nello stato di chi la mostra (mai in una cache), resta
// finché non si preme «Hide» (VA-Q3, maintainer) e sparisce quando la
// cassaforte si chiude; «Copy» non la riceve (gli appunti li scrive il livello
// dati, nell'app il main). A cassaforte chiusa Show e Copy aprono col Touch
// ID e poi fanno l'azione (VA-Q2).

/**
 * Il messaggio di un Show o Copy rifiutato. Il tetto delle letture (C2, 429
 * `vault_reveal_rate_limited`) è temporaneo e ha la sua frase, coi minuti
 * di `Retry-After`; tutto il resto è l'errore generico.
 */
function revealError(
  t: (key: string, options?: Record<string, unknown>) => string,
  out: { ok: boolean; code?: string; retryAfterSeconds?: number } | null,
): string {
  if (out && !out.ok && out.code === "vault_reveal_rate_limited") {
    const minutes = Math.max(1, Math.ceil((out.retryAfterSeconds ?? 600) / 60));
    return t("vault.revealLimited", { count: minutes });
  }
  return t("vault.revealFailed");
}

export function usePasswordReveal() {
  const { t } = useTranslation();
  const toast = useToast();
  const status = useVaultStatus().data;
  const { open } = useOpenVault();
  const showMutation = useShowPassword();
  const copyMutation = useCopyPassword();
  const [shown, setShown] = useState<Record<string, string>>({});
  const state = status?.state;
  // Chiusa (per tempo, stop, schermo, «Lock»): ogni password mostrata torna pallini.
  useEffect(() => {
    if (state !== "open") setShown({});
  }, [state]);
  // Cassaforte nel browser (design §6, I3): la password sparisce subito alla
  // chiusura (dal modulo della chiave, non dalla rilettura), quando la
  // scheda va in secondo piano e a `pagehide`. Show resta finché Hide (VA-Q3)
  // finché la scheda è davanti.
  const web = isWebAppBuild();
  useOnVaultChange(() => {
    if (web) setShown({});
  });
  useEffect(() => {
    if (!web) return;
    const hide = () => setShown({});
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", hide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", hide);
    };
  }, [web]);
  // A chiusa i gesti aprono prima; da associare, revocata o senza Touch ID non c'è niente da aprire qui.
  const { usable } = useVaultUsable();
  const ensureOpen = async () => state === "open" || (await open());

  return {
    shown,
    usable,
    locked: state !== "open",
    show: async (id: string) => {
      if (!(await ensureOpen())) return;
      const out = await showMutation.mutateAsync(id).catch(() => null);
      // Review I3: la password resta SOLO nello stato della riga; la
      // mutazione la scorda subito (e la cache, con `secret`, non la tiene).
      showMutation.reset();
      if (out?.ok) setShown((m) => ({ ...m, [id]: out.password }));
      else toast.error(revealError(t, out));
    },
    hide: (id: string) =>
      setShown((m) => {
        const next = { ...m };
        delete next[id];
        return next;
      }),
    copy: async (id: string) => {
      if (!(await ensureOpen())) return;
      const out = await copyMutation.mutateAsync(id).catch(() => null);
      if (out?.ok) toast.show(t(web ? "vault.copiedWeb" : "vault.copied"));
      else toast.error(revealError(t, out));
    },
  };
}
