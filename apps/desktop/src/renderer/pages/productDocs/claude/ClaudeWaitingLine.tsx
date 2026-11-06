import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePauserName } from "../../../components/InstanceBlock";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { useProductUpdatesWaiting } from "../../../data/queries";
import type { AiBlock } from "../../../data/types";
import { REDUCED_MOTION_QUERY, useMediaQuery } from "../../../layout/useMediaQuery";

// La riga dell'attesa in cima allo spazio Prodotto (11b, Task 11; shape
// product-claude-questions.md §3.8, [PQ 11]): quando aggiornamenti di
// Claude aspettano il budget del mese o la ripresa della coda, una riga
// sotto la barra dello spazio, a tutta larghezza, li conta (nessuna fonte è
// nominata) e dice quando ripartono, col «Who?» di chi sblocca
// (`manageSettings`, d'istanza: budget e pausa li gestisce chi ha
// `settings.manage`). Senza attese non c'è, anche col budget finito: spiega
// un ritardo, non annuncia il budget. Il simbolo è l'orologio neutro, non ▲:
// non è un errore della pagina. Al rilascio sparisce in 150 ms (zero con
// movimento ridotto). Il conteggio e il blocco li dà il livello dati (P11).

const FADE_MS = 150;

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75V8l2.25 1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ClaudeWaitingLine({ projectId }: { projectId: string }) {
  const waiting = useProductUpdatesWaiting(projectId).data ?? null;
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY);
  // L'ultima attesa vista resta a vista per la dissolvenza, poi se ne va.
  const [shown, setShown] = useState(waiting);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (waiting) {
      setShown(waiting);
      setLeaving(false);
      return;
    }
    if (reduced) {
      setShown(null);
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setShown(null);
      setLeaving(false);
    }, FADE_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, reduced]);

  if (!shown) return null;
  return (
    <WaitingRow count={shown.count} block={shown.block} leaving={leaving && !waiting} />
  );
}

function WaitingRow({ count, block, leaving }: { count: number; block: AiBlock; leaving: boolean }) {
  const { t } = useTranslation();
  const pauser = usePauserName(block);
  const reason =
    block.reason === "monthly_budget"
      ? t("productDocs.waiting.budget")
      : t("productDocs.waiting.queue", { name: pauser });
  const counted = t("productDocs.waiting.count", { count });
  // L'ultima parola del conteggio e «Who?» vanno a capo insieme ([PQ 11], 1024).
  const cut = counted.lastIndexOf(" ");
  return (
    <p
      data-claude-waiting=""
      style={leaving ? { opacity: 0, transition: `opacity ${FADE_MS}ms var(--ease)` } : undefined}
      className="flex min-h-8 shrink-0 items-start gap-2 border-b border-rule bg-ink/5 px-4 py-1.5 text-sm leading-5 text-ink-muted"
    >
      <span className="flex h-5 items-center">
        <ClockIcon />
      </span>
      <span className="min-w-0 text-pretty [overflow-wrap:anywhere]">
        {reason}
        <span aria-hidden="true"> · </span>
        <span className="num">{cut > 0 ? `${counted.slice(0, cut)} ` : ""}</span>
        <span className="whitespace-nowrap">
          <span className="num">{cut > 0 ? counted.slice(cut + 1) : counted}</span>
          <span aria-hidden="true"> · </span>
          <WhoCanLink action="manageSettings" projectId={null} />
        </span>
      </span>
    </p>
  );
}
