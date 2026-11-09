import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useHome, useSavedFilter, useSetPersonalHome, useTasks } from "../../../data/queries";
import type { HomeBlockRef, SavedFilter } from "../../../data/types";
import { sameBlock } from "../../../domain/home";
import { TaskRow } from "../../../tasks-ui/TaskRow";
import { useToast } from "../../../tasks-ui/Toast";
import { ghostButton, smallSecondary } from "../../task/parts";
import {
  BLOCK_CAP,
  BlockSection,
  queryState,
  useOpenTask,
  useReportDepartments,
} from "./BlockSection";
import { useStallsByCode } from "./MyTasksBlock";

/**
 * Un filtro salvato come blocco: il suo nome per titolo, quante task ci
 * trova chi guarda (la sua lettura, non quella dell'autore), le prime 5
 * righe e «Open». Un filtro eliminato, o reso privato da chi l'ha creato,
 * non c'è più: il blocco lo dice con calma e offre «Remove block», senza
 * righe vecchie.
 */
export function FilterBlock({ block }: { block: HomeBlockRef }) {
  const { t } = useTranslation();
  const filter = useSavedFilter(block.filterId ?? "");
  if (filter.data === null) return <GoneFilter block={block} />;
  if (!filter.data) {
    return <BlockSection title={t("home.blocks.filter")} state={queryState([filter])} />;
  }
  return <FilterRows filter={filter.data} />;
}

function FilterRows({ filter }: { filter: SavedFilter }) {
  const { t } = useTranslation();
  const tasks = useTasks(filter.criteria);
  const stalls = useStallsByCode();
  const openTask = useOpenTask();
  const list = tasks.data ?? [];
  useReportDepartments(`filter:${filter.id}`, list.slice(0, BLOCK_CAP));
  const state = queryState([tasks], { when: list.length === 0, text: t("home.filter.empty") });
  return (
    <BlockSection
      title={filter.name}
      count={list.length}
      state={state}
      action={
        <Link
          to="/filters/$id"
          params={{ id: filter.id }}
          aria-label={t("home.block.openTitle", { title: filter.name })}
          className={ghostButton}
        >
          {t("home.block.open")}
        </Link>
      }
    >
      <ul aria-label={filter.name} className="border-t border-rule">
        {list.slice(0, BLOCK_CAP).map((task) => (
          <li key={task.id}>
            <TaskRow
              task={task}
              density="regular"
              stall={stalls.get(task.code) ?? null}
              onOpen={(x) => openTask(x.code)}
            />
          </li>
        ))}
      </ul>
    </BlockSection>
  );
}

/** Il filtro non c'è più (eliminato, o privato di un altro): una riga calma e «Remove block». */
function GoneFilter({ block }: { block: HomeBlockRef }) {
  const { t } = useTranslation();
  const toast = useToast();
  const home = useHome().data;
  const save = useSetPersonalHome();
  const remove = () => {
    if (!home) return;
    const blocks = (home.personal?.blocks ?? home.blocks).filter((b) => !sameBlock(b, block));
    save.mutate(blocks, {
      onSuccess: () => toast.show(t("home.filter.removed")),
      onError: () => toast.error(t("home.filter.removeFailed")),
    });
  };
  return (
    <BlockSection title={t("home.blocks.filter")} state={{ status: "ready" }}>
      <div className="flex items-center gap-3 border-t border-rule py-3 pl-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-md text-ink">{t("home.filter.gone")}</p>
          <p className="text-sm text-ink-muted">{t("home.filter.goneBody")}</p>
        </div>
        <button
          type="button"
          className={smallSecondary}
          disabled={!home || save.isPending}
          onClick={remove}
        >
          {t("home.filter.remove")}
        </button>
      </div>
    </BlockSection>
  );
}
