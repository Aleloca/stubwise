import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useMyAutomationRuns } from "../../../data/queries";
import { RunRow } from "../../automations/RunList";
import { useNames } from "../../automations/shared";
import { BLOCK_CAP, BlockSection, queryState, rowKeys } from "./BlockSection";

/**
 * «Automations» (shape automations.md §6, [A 25]): le esecuzioni che mi
 * riguardano — che aspettano me, fallite di ciò che gestisco, non finite
 * delle mie automazioni —, in quest'ordine. Cinque righe e «Show all», che
 * apre le stesse in `#/automations?view=runs&mine=1`. Nessun bottone: le
 * approvazioni stanno anche in «Decide», qui la riga porta all'esecuzione.
 */
export function AutomationsBlock() {
  const { t } = useTranslation();
  const runs = useMyAutomationRuns();
  const names = useNames();
  const list = runs.data ?? [];
  const state = queryState([runs], {
    when: list.length === 0,
    text: t("home.automations.empty"),
  });
  return (
    <BlockSection
      title={t("home.blocks.automations")}
      count={list.length}
      state={state}
      action={
        list.length > BLOCK_CAP && (
          <Link
            to="/automations"
            search={{ view: "runs", mine: "1" } as never}
            className="rounded-sm px-2 text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
          >
            {t("home.automations.showAll", { count: list.length })}
          </Link>
        )
      }
    >
      <ul
        aria-label={t("home.blocks.automations")}
        onKeyDown={rowKeys("[data-run-row]")}
        className="flex flex-col border-t border-rule"
      >
        {list.slice(0, BLOCK_CAP).map((r) => (
          <RunRow key={r.id} run={r} names={names} mine={r.concern === "waiting_me"} />
        ))}
      </ul>
    </BlockSection>
  );
}
