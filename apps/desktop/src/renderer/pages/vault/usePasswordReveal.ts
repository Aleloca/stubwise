import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCopyPassword, useShowPassword, useVaultStatus } from "../../data/queries";
import { useToast } from "../../tasks-ui/Toast";
import { useOpenVault } from "./VaultBar";

// Mostrare, nascondere e copiare una password (shape `vault.md` §3), le
// stesse regole nelle righe e nel pannello di dettaglio: la password
// mostrata sta SOLO nello stato di chi la mostra (mai in una cache), resta
// finché non si preme «Hide» (VA-Q3, maintainer) e sparisce quando la
// cassaforte si chiude; «Copy» non la riceve (gli appunti li scrive il livello
// dati, nell'app il main). A cassaforte chiusa Show e Copy aprono col Touch
// ID e poi fanno l'azione (VA-Q2).

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
  // A chiusa i gesti aprono prima; da associare, revocata o senza Touch ID non c'è niente da aprire qui.
  const usable = state === "open" || (state === "locked" && status?.touchId === true);
  const ensureOpen = async () => state === "open" || (await open());

  return {
    shown,
    usable,
    show: async (id: string) => {
      if (!(await ensureOpen())) return;
      const out = await showMutation.mutateAsync(id).catch(() => null);
      if (out?.ok) setShown((m) => ({ ...m, [id]: out.password }));
      else toast.error(t("vault.revealFailed"));
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
      if (out?.ok) toast.show(t("vault.copied"));
      else toast.error(t("vault.revealFailed"));
    },
  };
}
