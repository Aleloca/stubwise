import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { inboxKeys, inboxUnreadQueryOptions } from "../lib/queries";

/** Oltre questa soglia il contatore smette di contare e dice "tanti". */
const COUNT_CAP = 99;

/**
 * Tiene le LISTE dell'inbox allineate al CONTATORE.
 *
 * `inboxQueryOptions` non fa polling di proposito (la lista è pesante): l'unica
 * query che gira di continuo è il contatore delle non lette, ogni 30s. Quando
 * il suo valore CAMBIA è arrivato (o è stato chiuso) qualcosa, quindi si
 * invalidano le liste: una `/inbox` lasciata aperta si aggiorna entro 30s senza
 * ricaricare la pagina.
 *
 * È un hook a sé, e NON un effetto dentro {@link InboxBell}, perché la
 * campanella è renderizzata DUE volte (sidebar desktop + top bar mobile): un
 * effetto nel componente girerebbe in doppio. Il proprietario del wiring è
 * l'`AppLayout`, che lo monta una volta sola.
 *
 * FLICKER NOTO: l'invalidazione è cieca rispetto alle mutazioni in corso. Se
 * cade mentre uno snooze è in volo, il refetch che ne segue riporta la riga
 * (per il server è ancora aperta) e per un istante la si rivede, dopo che
 * l'update ottimistico l'aveva tolta. Converge da sé: l'`onSettled` dello
 * snooze invalida di nuovo e il giro successivo la fa sparire per davvero. Si
 * accetta perché la finestra è di frazioni di secondo e rara (serve che il
 * contatore cambi PROPRIO lì in mezzo), e l'alternativa — sospendere le
 * invalidazioni finché c'è una mutazione aperta — costerebbe molto più di
 * quello che evita.
 */
export function useInboxUnreadWatcher(): void {
  const queryClient = useQueryClient();
  const { data } = useQuery(inboxUnreadQueryOptions());
  const count = data?.count;
  // `undefined` finché non è arrivato il primo valore: la prima lettura
  // registra soltanto la baseline, non è "un cambiamento".
  const previous = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (count === undefined) return;
    const before = previous.current;
    previous.current = count;
    if (before === undefined || before === count) return;
    void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
  }, [count, queryClient]);
}

/**
 * Campanella dell'inbox: icona + contatore delle non lette, link a `/inbox`.
 *
 * A zero il numero SPARISCE (nessun "0" da leggere e ignorare); oltre 99 diventa
 * "99+", perché il numero esatto non cambia più la decisione. La query è
 * condivisa (stessa chiave) fra le due istanze — sidebar e top bar mobile — e
 * quindi una sola richiesta di rete.
 */
export function InboxBell({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const { data } = useQuery(inboxUnreadQueryOptions());
  const count = data?.count ?? 0;
  const label = count > 0 ? t("inbox:bell.labelWithCount", { count }) : t("inbox:bell.label");

  return (
    <Link
      to="/inbox"
      aria-label={label}
      title={label}
      className={`relative inline-flex shrink-0 items-center rounded-sm p-1.5 text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg ${className}`}
      activeProps={{ className: "text-signal" }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-5"
      >
        <path d="M18 8a6 6 0 0 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
        <path d="M10.5 19a1.9 1.9 0 0 0 3 0" />
      </svg>
      {count > 0 && (
        // `aria-hidden`: il numero è già nell'aria-label del link, e da solo
        // ("3") non direbbe nulla a uno screen reader.
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-signal px-1 text-center font-mono text-[10px] leading-4 font-semibold text-ink-950"
        >
          {count > COUNT_CAP ? `${COUNT_CAP}+` : count}
        </span>
      )}
    </Link>
  );
}
