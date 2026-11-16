import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useMailWaitingCustomers } from "../../../data/queries";
import type { WaitingCustomer } from "../../../data/mail";
import { sinceWords } from "../../support/format";
import { BlockSection, Capped, queryState, rowKeys } from "./BlockSection";

/**
 * «Clienti in attesa» (area 8, piano di 72; [A 17]): i thread delle MIE
 * caselle in cui un cliente aspetta una mia risposta da più di 24 ore, dalla
 * più vecchia attesa (`mail.listWaitingCustomers`). Decide Claude se la
 * risposta serve: la riga dice il suo motivo (testo, non fidato) o «da
 * valutare» se non l'ha ancora giudicato; un «no» non arriva. Nel catalogo,
 * mai nelle Home di default. Il clic apre il thread nella Posta.
 */

const rowClass =
  "grid min-h-11 grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_48px_96px] items-center gap-x-3 gap-y-0.5 rounded-md px-4 py-1.5 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:bg-ink/6";

function Row({ row }: { row: WaitingCustomer }) {
  const { t } = useTranslation();
  const who = row.customer.name ?? row.customer.email;
  // Il segnale della classificazione (R2): una parola; uno ignoto o «none» non si dice.
  const signal =
    row.signal && row.signal !== "none"
      ? t(`home.waitingCustomers.signals.${row.signal}`, { defaultValue: "" })
      : "";
  return (
    <li className="border-b border-rule" data-waiting-thread={row.threadId}>
      <Link
        to="/mail/$threadId"
        params={{ threadId: row.threadId }}
        data-waiting-row
        className={rowClass}
      >
        <span
          className="min-w-0 truncate text-md font-semibold text-ink"
          title={row.customer.email}
        >
          {who}
        </span>
        <span className="min-w-0 truncate text-md text-ink">
          {row.subject ?? t("mail.row.noSubject")}
        </span>
        <span className="num text-xs text-ink-muted" title={row.project.name}>
          {row.project.code}
        </span>
        {/* Neutro (review M3): oltre le 24 ore aspettano tutte, nessun colore d'allarme. */}
        <span className="num text-xs text-ink-muted">
          {t("support.waiting", { time: sinceWords(row.waitingSince, t) })}
        </span>
        <span className="col-span-4 flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
          {signal && <span className="shrink-0 font-medium text-ink">{signal}</span>}
          {/* Il ramo è sul giudizio (review M1): un «sì» senza motivo non è «da valutare». */}
          {row.judgment === "yes" ? (
            <span className="min-w-0 text-pretty text-ink-muted [overflow-wrap:anywhere]">
              {row.reason ?? t("home.waitingCustomers.yesNoReason")}
            </span>
          ) : (
            <span className="text-ink-faint" data-waiting-pending>
              {t("home.waitingCustomers.pending")}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

export function WaitingCustomersBlock() {
  const { t } = useTranslation();
  const q = useMailWaitingCustomers();
  const rows = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const state = queryState([q], {
    when: rows.length === 0,
    text: t("home.waitingCustomers.empty"),
  });
  return (
    <BlockSection title={t("home.blocks.waitingCustomers")} count={total} state={state}>
      <div onKeyDown={rowKeys("[data-waiting-row]")}>
        <Capped
          items={rows}
          label={t("home.blocks.waitingCustomers")}
          render={(row) => <Row key={`${row.accountEmail}|${row.threadId}`} row={row} />}
        />
      </div>
    </BlockSection>
  );
}
