import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useWaitingCustomers } from "../../../data/queries";
import { customerName, WaitingSince } from "../../support/format";
import { BlockSection, Capped, queryState, rowKeys } from "./BlockSection";

/**
 * «Clienti in attesa» (shape support.md §6, [A 17]): le conversazioni che
 * aspettano una nostra risposta, nei progetti dove posso rispondere, dalla
 * più vecchia attesa. Nel catalogo di chi ha `support.reply` in almeno un
 * progetto, mai nelle Home di default. Il clic apre il dettaglio.
 */

const rowClass =
  "grid min-h-11 grid-cols-[40px_64px_minmax(0,0.9fr)_96px_minmax(0,1.4fr)] items-center gap-3 rounded-md px-4 py-1.5 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:bg-ink/6";

export function WaitingCustomersBlock() {
  const { t } = useTranslation();
  const q = useWaitingCustomers();
  const rows = q.data ?? [];
  const state = queryState([q], {
    when: rows.length === 0,
    text: t("home.waitingCustomers.empty"),
  });
  return (
    <BlockSection title={t("home.blocks.waitingCustomers")} count={rows.length} state={state}>
      <div onKeyDown={rowKeys("[data-waiting-row]")}>
        <Capped
          items={rows}
          label={t("home.blocks.waitingCustomers")}
          render={(c) => (
            <li key={c.code} className="border-b border-rule">
              <Link
                to="/p/$code/support/$conversation"
                params={{ code: c.projectCode, conversation: c.code }}
                data-waiting-row
                className={rowClass}
              >
                <span className="num text-xs text-ink-muted">{c.projectCode}</span>
                <span className="num text-xs font-semibold text-ink">{c.code}</span>
                <span className="min-w-0 truncate text-md text-ink">{customerName(c, t)}</span>
                {c.waitingSince ? <WaitingSince since={c.waitingSince} /> : <span />}
                <span className="min-w-0 truncate text-sm text-ink-muted">
                  {c.lastMessage?.body}
                </span>
              </Link>
            </li>
          )}
        />
      </div>
    </BlockSection>
  );
}
