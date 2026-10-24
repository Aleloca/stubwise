import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePeople, useProjectStatuses, useTasks } from "../../data/queries";
import type { FilterCriteria, Person } from "../../data/types";
import { Avatar } from "../../tasks-ui/PersonChip";
import { ghostButton } from "../task/parts";
import { BlockSection, queryState } from "../home/blocks/BlockSection";
import { TasksLink, countLinkClass } from "./links";

const OPEN: FilterCriteria["families"] = ["todo", "active"];
/** Quante persone si vedono prima di «Show N more». */
const PEOPLE_CAP = 6;

/**
 * «What's open» (la seconda domanda): le task aperte per famiglia di stato
 * e per persona, in numeri tabellari grandi — testo, non tessere — ognuno un
 * link alle Tasks già filtrate. Due colonne quando la colonna di lettura è
 * piena (finestra da 1280 in su, pannello chiuso), una sotto.
 */
export function OpenSection({
  projectId,
  projectCode,
}: {
  projectId: string;
  projectCode: string;
}) {
  const { t } = useTranslation();
  const tasks = useTasks({ projectIds: [projectId], families: OPEN });
  const statuses = useProjectStatuses(projectId);
  const people = usePeople();
  const [allPeople, setAllPeople] = useState(false);
  const open = tasks.data ?? [];
  const total = open.length;

  const familyById = new Map((statuses.data ?? []).map((s) => [s.id, s.family]));
  const byFamily = (["todo", "active"] as const).map((family) => ({
    family,
    count: open.filter((x) => familyById.get(x.statusId) === family).length,
  }));

  const counts = new Map<string | null, number>();
  for (const task of open) counts.set(task.assigneeId, (counts.get(task.assigneeId) ?? 0) + 1);
  const rows = [...counts.entries()]
    .map(([id, count]) => ({
      id,
      count,
      person: id ? people.data?.find((p) => p.id === id) : undefined,
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        // «Unassigned» in fondo a parità; poi per nome.
        (a.id === null ? 1 : 0) - (b.id === null ? 1 : 0) ||
        (a.person?.name ?? "").localeCompare(b.person?.name ?? ""),
    );
  const shownRows = allPeople ? rows : rows.slice(0, PEOPLE_CAP);

  const state = queryState([tasks, statuses, people], {
    when: total === 0,
    text: t("overview.open.empty"),
  });

  // La risposta in una riga accanto al titolo («4 to do · 5 in progress»): si
  // legge senza scorrere anche quando le ferme riempiono la prima schermata.
  const summary =
    state.status === "ready" ? (
      <span data-open-summary>
        {byFamily.map(({ family, count }, i) => (
          <span key={family}>
            {i > 0 && <span aria-hidden="true"> · </span>}
            <TasksLink
              projectCode={projectCode}
              criteria={{ families: [family] }}
              label={t(`overview.open.summaryLink.${family}`, { count })}
              className="rounded-sm underline-offset-4 decoration-ink/40 hover:text-ink hover:underline"
            >
              <span className="num font-semibold text-ink">{count}</span>{" "}
              {t(`overview.open.summary.${family}`)}
            </TasksLink>
          </span>
        ))}
      </span>
    ) : undefined;

  return (
    <BlockSection
      title={t("overview.open.title")}
      count={total}
      countLink={(n) => (
        <TasksLink
          projectCode={projectCode}
          criteria={{ families: OPEN }}
          label={t("overview.open.totalLink", { count: total })}
          className={countLinkClass}
        >
          {n}
        </TasksLink>
      )}
      state={state}
      meta={summary}
    >
      <div className="@container border-t border-rule">
        <div className="grid grid-cols-1 gap-x-10 @min-[880px]:grid-cols-2">
          <div>
            <h3 className="heading-group flex h-9 items-end pb-2 pl-4">
              {t("overview.open.byFamily")}
            </h3>
            <ul className="border-t border-rule">
              {byFamily.map(({ family, count }) => (
                <CountRow
                  key={family}
                  projectCode={projectCode}
                  criteria={{ families: [family] }}
                  label={t(`taskUi.families.${family}`)}
                  linkLabel={t(`overview.open.familyLink.${family}`, { count })}
                  count={count}
                />
              ))}
            </ul>
          </div>
          <div>
            <h3 className="heading-group flex h-9 items-end pb-2 pl-4">
              {t("overview.open.byPerson")}
            </h3>
            <ul className="border-t border-rule">
              {shownRows.map(({ id, count, person }) => (
                <CountRow
                  key={id ?? "none"}
                  projectCode={projectCode}
                  criteria={{ assigneeIds: [id ?? "none"], families: OPEN }}
                  label={person?.name ?? t("taskUi.unassigned")}
                  linkLabel={t("overview.open.personLink", {
                    name: person?.name ?? t("taskUi.unassigned"),
                    count,
                  })}
                  count={count}
                  person={id ? (person ?? null) : undefined}
                />
              ))}
            </ul>
            {rows.length > PEOPLE_CAP && (
              <button
                type="button"
                aria-expanded={allPeople}
                className={`${ghostButton} mt-1 ml-2`}
                onClick={() => setAllPeople((v) => !v)}
              >
                {allPeople
                  ? t("home.block.showFewer")
                  : t("home.block.showMore", { count: rows.length - PEOPLE_CAP })}
              </button>
            )}
          </div>
        </div>
      </div>
    </BlockSection>
  );
}

/**
 * Una riga «etichetta … numero»: tutta la riga è il link (al passaggio la
 * tinta, il numero si sottolinea). Il nome accessibile dice numero e cosa
 * conta («12 in progress»), non solo la cifra.
 */
function CountRow({
  projectCode,
  criteria,
  label,
  linkLabel,
  count,
  person,
}: {
  projectCode: string;
  criteria: FilterCriteria;
  label: string;
  linkLabel: string;
  count: number;
  /** Una persona (avatar), `null` se non si trova più; assente per famiglie e «Unassigned». */
  person?: Person | null;
}) {
  return (
    <li className="border-b border-rule">
      <TasksLink
        projectCode={projectCode}
        criteria={criteria}
        label={linkLabel}
        className="group flex h-11 items-center gap-3 pr-3 pl-4 outline-none transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      >
        {person !== undefined && <Avatar person={person} />}
        <span className="min-w-0 flex-1 truncate text-md text-ink">{label}</span>
        <span className="num text-xl font-semibold text-ink underline-offset-4 decoration-ink/40 group-hover:underline">
          {count}
        </span>
      </TasksLink>
    </li>
  );
}
