import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * Atomi condivisi fra le due superfici che mostrano l'inventario di un plugin:
 * le impostazioni d'istanza (dove l'inventario è una LISTA da leggere) e la
 * pagina progetto (dove è una superficie di SELEZIONE, con una casella per
 * voce). Sono due letture diverse dello stesso dato, quindi si condividono i
 * mattoni — non il pannello.
 */

/** Gruppo dell'inventario con titolo mono e vuoto esplicito. */
export function InventoryGroup({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
        {title}
      </span>
      {empty ? (
        <p className="font-mono text-[11px] text-fg-faint">{t("settings:plugins.emptyList")}</p>
      ) : (
        <ul className="flex flex-col gap-1">{children}</ul>
      )}
    </div>
  );
}

/**
 * Comando di un hook, in chiaro.
 *
 * Un hook è codice che gira a ogni run del progetto: il comando non si
 * riassume e non si nasconde dietro un nome di evento. Vale doppio nella
 * pagina progetto, dove è il momento in cui quel rischio lo si accetta
 * davvero.
 */
export function HookCommand({ command }: { command: string }) {
  return (
    <span className="rounded-sm border border-line bg-ink-950/70 px-2 py-1 font-mono text-[11px] break-all text-fg-muted">
      {command}
    </span>
  );
}
