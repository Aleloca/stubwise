import { useTranslation } from "react-i18next";
import { useVaultStatus } from "../../data/queries";

/**
 * Un gesto della cassaforte si può fare DA QUI: aperta, oppure chiusa con il
 * Touch ID (il gesto lo chiede da sé, [VA 4] e M7). Da associare, revocata,
 * senza Touch ID o irraggiungibile la barra dice cosa fare, e il gesto è
 * spento con `title` (quarta revisione, punto 2: la stessa regola di Show e
 * Copy, ora anche per Share, Remove, Confirm e Reject).
 */
export function useVaultUsable(): { usable: boolean; title: string | undefined; locked: boolean } {
  const { t } = useTranslation();
  const status = useVaultStatus().data;
  const state = status?.state;
  const usable = state === "open" || (state === "locked" && status?.touchId === true);
  return {
    usable,
    locked: state !== "open",
    title: state !== "open" ? t("vault.row.openFirst") : undefined,
  };
}

/** Annullare il Touch ID è una scelta: nessun avviso (come all'apertura). */
export const isTouchCancelled = (out: unknown): boolean =>
  typeof out === "object" &&
  out !== null &&
  (out as { code?: unknown }).code === "touch_id_cancelled";
