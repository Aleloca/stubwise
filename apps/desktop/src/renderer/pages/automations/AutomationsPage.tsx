import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAutomationRuns, useAutomations } from "../../data/queries";
import { useViewer } from "../../data/viewer";
import { MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { Placeholder } from "../Placeholder";
import { Chevron, MenuButton, primaryButton } from "../tasks/controls";
import { AttentionView, AutomationListView, type ListSearch } from "./AutomationList";
import { AutomationDetail, DetailSkeleton } from "./AutomationDetail";
import { CreateAutomationDialog, type AutomationTemplate } from "./CreateAutomationDialog";
import { isFinished } from "./format";
import { RunDetail } from "./RunDetail";
import { RunsView } from "./RunList";
import { NotVisible, useAttention, useAutomationPerms } from "./shared";

// Le route della destinazione Automations (shape automations.md):
// `#/automations` (elenco, `?view=runs`, `?view=attention`), il dettaglio di
// un'automazione per codice, quello di un'esecuzione («AUD-A1 #2» →
// `/automations/AUD-A1/runs/2`). Il codice si risolve fra ciò che chi guarda
// vede: inesistente e invisibile rispondono uguale (R-G5). Cambiare persona
// rimonta la pagina (chiave): niente della persona di prima resta a schermo.

type Search = ListSearch & { view?: string; automation?: string; mine?: string; entry?: string };

/** «New automation ▾»: vuota, o da uno dei due modelli. */
function NewAutomationButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<AutomationTemplate | "blank" | null>(null);
  return (
    <>
      <MenuButton
        menuLabel={t("automations.actions.new")}
        align="right"
        className={primaryButton}
        label={
          <>
            {t("automations.actions.new")}
            <Chevron />
          </>
        }
      >
        {(close) => (
          <>
            <MenuGroup>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={itemClass}
                onClick={() => {
                  close();
                  setOpen("blank");
                }}
              >
                {t("automations.create.blank")}
              </button>
            </MenuGroup>
            <MenuGroup label={t("automations.templates.menu")}>
              {(["newContract", "askClient"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    close();
                    setOpen(k);
                  }}
                >
                  {t(`automations.templates.${k}.title`)}
                </button>
              ))}
            </MenuGroup>
          </>
        )}
      </MenuButton>
      {open && (
        <CreateAutomationDialog
          template={open === "blank" ? undefined : open}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function ListPage({ search }: { search: Search }) {
  const { t } = useTranslation();
  const perms = useAutomationPerms();
  const automations = useAutomations().data;
  const runs = useAutomationRuns().data;
  const attention = useAttention();
  const view = search.view === "runs" ? "runs" : search.view === "attention" ? "attention" : "list";
  const title = t(`automations.titles.${view}`);
  const count =
    view === "runs"
      ? runs?.filter((r) => !isFinished(r.status)).length
      : view === "attention"
        ? attention.ready
          ? attention.count
          : undefined
        : automations?.length;
  return (
    <section className="flex min-h-full flex-col pb-16 pl-8">
      <header className="page-header flex shrink-0 items-center gap-3 pb-5 [--page-header-pr:32px] [--page-header-pt:32px]">
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {count !== undefined && count > 0 && (
          <span className="num text-2xl text-ink-faint">{count}</span>
        )}
        {perms.anywhere && (
          <span className="ml-auto pr-8">
            <NewAutomationButton />
          </span>
        )}
      </header>
      {view === "runs" ? (
        <RunsView search={search} />
      ) : view === "attention" ? (
        <AttentionView />
      ) : (
        <AutomationListView search={search} />
      )}
    </section>
  );
}

/** `#/automations` */
export function AutomationsPage() {
  const { viewer } = useViewer();
  const search = useSearch({ strict: false }) as Search;
  return <ListPage key={viewer.personId} search={search} />;
}

function AutomationByCode({ code }: { code: string }) {
  const { t } = useTranslation();
  const list = useAutomations();
  if (list.isError)
    return (
      <PageError message={t("automations.errors.loadOne")} onRetry={() => void list.refetch()} />
    );
  if (list.data === undefined) return <DetailSkeleton />;
  const a = list.data.find((x) => x.code === code);
  if (!a) return <NotVisible what="automation" />;
  return <AutomationDetail key={a.id} automationId={a.id} />;
}

/** `#/automations/<CODE>` */
export function AutomationRoutePage({ code }: { code: string }) {
  const { viewer } = useViewer();
  return <AutomationByCode key={`${viewer.personId}:${code}`} code={code} />;
}

function RunByCode({ code, n, entry }: { code: string; n: string; entry?: string }) {
  const { t } = useTranslation();
  // Le esecuzioni che vedo (anche quelle che devo decidere senza vedere l'automazione).
  const runs = useAutomationRuns();
  if (runs.isError)
    return (
      <PageError message={t("automations.errors.loadRun")} onRetry={() => void runs.refetch()} />
    );
  if (runs.data === undefined) return <DetailSkeleton />;
  const run = runs.data.find((r) => r.automationCode === code && String(r.n) === n);
  if (!run) return <NotVisible what="run" />;
  return <RunDetail key={run.id} runId={run.id} entry={entry} />;
}

/** `#/automations/<CODE>/runs/<n>` */
export function RunRoutePage({ code, n }: { code: string; n: string }) {
  const { viewer } = useViewer();
  const search = useSearch({ strict: false }) as Search;
  return (
    <RunByCode key={`${viewer.personId}:${code}:${n}`} code={code} n={n} entry={search.entry} />
  );
}

/**
 * Il costruttore e la prova (`/automations/<CODE>/edit`, `/test`): li
 * costruiscono i Task 6 e 7; qui la route esiste già perché i bottoni
 * «Edit», «Test» e «Fix» del dettaglio ci portano.
 */
export function AutomationToolPage({ tool }: { tool: "edit" | "test" }) {
  return (
    <Placeholder
      titleKey={`automations.tools.${tool}.title`}
      bodyKey={`automations.tools.${tool}.body`}
    />
  );
}
