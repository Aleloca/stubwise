import { useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { aiTabsFor } from "../../../data/adminSections";
import type { AI_TABS } from "../../../data/routes";
import { can, useViewer } from "../../../data/viewer";
import { AutomationPanel } from "./AutomationPanel";
import { BudgetPanel } from "./BudgetPanel";
import { ModelsPanel } from "./ModelsPanel";
import { ProvidersPanel } from "./ProvidersPanel";

// La voce AI dell'Amministrazione (area 9b, Task 8, shape admin-ai.md): h1,
// riga in prosa e cinque schede, ognuna una domanda. Quali schede si vedono
// lo decide `aiTabsFor` (Usage con `usage.view`, le altre con
// `ai_providers.manage` o `settings.manage`); la scheda sta nell'indirizzo
// (`?tab=`), e una sconosciuta o non visibile apre la prima visibile senza
// messaggio [AI 3]. Con una sola scheda (l'Auditor) la barra non c'è.
// Chi scrive cosa: Providers con `ai_providers.manage`, le altre con
// `settings.manage`; senza, la scheda si legge (`ReadOnlyLine`).

type AiTab = (typeof AI_TABS)[number];

export function AiPage() {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const tabs = aiTabsFor(viewer);
  const search = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const current: AiTab = tabs.find((tab) => tab === search.tab) ?? tabs[0]!;
  const baseId = useId();
  const tabId = (tab: AiTab) => `${baseId}-tab-${tab}`;
  const panelId = `${baseId}-panel`;
  const select = (tab: AiTab) =>
    void navigate({
      to: "/admin/$section",
      params: { section: "ai" },
      search: ((prev: Record<string, unknown>) => ({ ...prev, tab })) as never,
    });

  const writesProviders = can(viewer, "ai_providers.manage");
  const writesSettings = can(viewer, "settings.manage");

  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className={current === "usage" ? "max-w-[1040px]" : "max-w-[880px]"}>
        <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">{t("admin.ai.title")}</h1>
        <p className="mt-2 max-w-[62ch] text-md text-pretty text-ink-muted">{t("admin.ai.intro")}</p>
        {tabs.length > 1 && (
          <TabBar tabs={tabs} current={current} tabId={tabId} panelId={panelId} onSelect={select} />
        )}
        <div
          id={panelId}
          role={tabs.length > 1 ? "tabpanel" : undefined}
          aria-labelledby={tabs.length > 1 ? tabId(current) : undefined}
          className="mt-5"
        >
          {current === "providers" && <ProvidersPanel canWrite={writesProviders} />}
          {current === "models" && <ModelsPanel canWrite={writesSettings} />}
          {current === "automation" && <AutomationPanel canWrite={writesSettings} />}
          {current === "budget" && <BudgetPanel canWrite={writesSettings} />}
          {current === "usage" && (
            // Il contenuto di Usage arriva col Task 9 (ruling 23).
            <p className="max-w-[62ch] text-md text-pretty text-ink-muted">
              {t("admin.ai.usageIntro")}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * La barra delle schede (36 px, filetto sotto): la scheda attiva in
 * inchiostro 600 con la sottolineatura di 2 px, che scorre in 150 ms da una
 * scheda all'altra. Frecce e Home/End spostano la scelta (tabindex mobile).
 * Se non ci sta (le etichette italiane sono più lunghe) scorre in orizzontale.
 */
function TabBar({
  tabs,
  current,
  tabId,
  panelId,
  onSelect,
}: {
  tabs: AiTab[];
  current: AiTab;
  tabId: (tab: AiTab) => string;
  panelId: string;
  onSelect: (tab: AiTab) => void;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[aria-selected="true"]`);
    if (el) setBar({ left: el.offsetLeft, width: el.offsetWidth });
  }, [current]);

  function onKeyDown(e: KeyboardEvent) {
    const at = tabs.indexOf(current);
    const next =
      e.key === "ArrowRight"
        ? tabs[(at + 1) % tabs.length]
        : e.key === "ArrowLeft"
          ? tabs[(at - 1 + tabs.length) % tabs.length]
          : e.key === "Home"
            ? tabs[0]
            : e.key === "End"
              ? tabs.at(-1)
              : undefined;
    if (!next) return;
    e.preventDefault();
    onSelect(next);
    requestAnimationFrame(() => document.getElementById(tabId(next))?.focus());
  }

  return (
    <div className="relative mt-5 overflow-x-auto [scrollbar-width:none]">
      <div
        ref={list}
        role="tablist"
        aria-label={t("admin.ai.tabsLabel")}
        onKeyDown={onKeyDown}
        className="relative flex h-9 min-w-max items-stretch gap-5 border-b border-rule"
      >
        {tabs.map((tab) => {
          const selected = tab === current;
          return (
            <button
              key={tab}
              id={tabId(tab)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(tab)}
              className={`-mb-px rounded-sm text-md whitespace-nowrap transition-colors duration-[var(--duration-fast)] ease-out ${
                selected ? "font-semibold text-ink" : "text-ink-muted hover:text-ink"
              }`}
            >
              {t(`admin.ai.tabs.${tab}`)}
            </button>
          );
        })}
        {bar && (
          <span
            aria-hidden="true"
            style={{ transform: `translateX(${bar.left}px)`, width: bar.width }}
            className="pointer-events-none transition-[transform,width] duration-[var(--duration-fast)] ease-out absolute bottom-[-1px] left-0 h-0.5 bg-ink"
          />
        )}
      </div>
    </div>
  );
}
