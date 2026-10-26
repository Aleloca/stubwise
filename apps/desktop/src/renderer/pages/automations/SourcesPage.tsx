import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAutomationRuns,
  useAutomations,
  useAutomationSources,
  usePeople,
} from "../../data/queries";
import type { AutomationSourceView } from "../../data/types";
import { MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { PageSkeleton } from "../../tasks-ui/PageStates";
import { Avatar } from "../../tasks-ui/PersonChip";
import { rowKeys } from "../home/blocks/BlockSection";
import {
  MenuButton,
  Chevron,
  primaryButton,
  quietButton,
  secondaryButton,
} from "../tasks/controls";
import { ClientLinks } from "./ClientLinks";
import { shortDate } from "./format";
import { MoreGlyph, SourceGlyph } from "./glyphs";
import { NotVisible, useAutomationPerms } from "./shared";
import { usersOf, sampleWords, useOpenSource, useSimulate } from "./sourceHelpers";
import { ConnectDialog, DisconnectDialog, NewWebhookDialog } from "./SourceDialogs";
import { StatusWord } from "./SourcePanel";

// Le sorgenti (shape automation-sources.md): un quadro dei contatori — ogni
// sorgente con la sua spia in parola, chi l'ha collegata e cosa alimenta —
// e il registro cliente → progetto. Solo con `integrations.manage` ([A 2]):
// senza, la pagina risponde come una che non esiste (R-G5). I connettori sono
// simulati e lo si dice una volta, nel riquadro «Prototype only».

function SourceRow({ source, open }: { source: AutomationSourceView; open: boolean }) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const automations = useAutomations().data;
  const runs = useAutomationRuns().data;
  const openSource = useOpenSource();
  const simulate = useSimulate(source);
  const [dialog, setDialog] = useState<"connect" | "disconnect" | null>(null);
  const users = usersOf(source, automations);
  const connector = people?.find((p) => p.id === source.connectedById);
  const last = (runs ?? [])
    .filter((r) => r.origin === "source" && users.some((a) => a.id === r.automationId))
    .map((r) => r.startedAt)
    .sort()
    .at(-1);
  const brings =
    source.kind === "webhook"
      ? t("automations.sources.incomingWebhook")
      : t("automations.sources.dealsWon");
  const when =
    source.status === "expired"
      ? source.expiredAt
        ? t("automations.sources.expiredOn", { date: shortDate(source.expiredAt, i18n.language) })
        : t("automations.sources.expiredLine")
      : source.status === "disconnected"
        ? t("automations.sources.disconnectedLine")
        : last
          ? t("automations.sources.lastEvent", { date: shortDate(last, i18n.language) })
          : t("automations.sources.noEvents");
  const usedBy =
    users.length === 0
      ? t("automations.sources.usedByNone")
      : users.length > 3
        ? t("automations.sources.usedByMany", { count: users.length })
        : t("automations.sources.usedBy", { codes: users.map((a) => a.code).join(", ") });
  return (
    <li className="group relative border-b border-rule">
      <button
        type="button"
        data-source-row={source.id}
        aria-current={open ? "true" : undefined}
        aria-label={t("automations.sources.rowLabel", {
          name: source.name,
          status: t(`automations.sources.status.${source.status}`),
          who: connector?.name ?? "",
          count: users.length,
        })}
        onClick={() => openSource(open ? undefined : source.id)}
        className="flex min-h-14 w-full flex-col justify-center gap-0.5 rounded-md px-3 py-2 text-left transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-[current=true]:bg-ink/10"
      >
        <span className="flex min-w-0 items-center gap-3 pr-48">
          <SourceGlyph kind={source.kind} />
          <span className="truncate text-md text-ink">{source.name}</span>
          <StatusWord status={source.status} />
          <span className="flex min-w-0 items-center gap-2">
            <Avatar person={connector} />
            <span className="truncate text-sm text-ink-muted max-[1100px]:sr-only">
              {connector?.name}
            </span>
          </span>
        </span>
        <span className="truncate pl-7 text-sm text-ink-muted">
          {brings} · {when} · {usedBy}
        </span>
      </button>
      <span className="absolute top-2.5 right-3 flex items-center gap-1">
        {source.status !== "connected" ? (
          <>
            {/* Spento, col perché in tooltip (shape sources [A 9]). */}
            <span
              title={t("automations.sources.simulateOff", { name: source.name })}
              className="opacity-0 transition-opacity duration-[var(--duration-fast)] ease-out group-focus-within:opacity-100 group-hover:opacity-100"
            >
              <button
                type="button"
                disabled
                aria-describedby={`simulate-off-${source.id}`}
                className={`${quietButton} h-7 disabled:opacity-50`}
              >
                {t("automations.sources.simulate")}
              </button>
              <span id={`simulate-off-${source.id}`} className="sr-only">
                {t("automations.sources.simulateOff", { name: source.name })}
              </span>
            </span>
            <button
              type="button"
              className={`${secondaryButton} h-7`}
              onClick={() => setDialog("connect")}
            >
              {source.status === "expired"
                ? t("automations.sources.reconnect")
                : t("automations.sources.connect")}
            </button>
          </>
        ) : (
          <span className="flex items-center gap-1 opacity-0 transition-opacity duration-[var(--duration-fast)] ease-out group-focus-within:opacity-100 group-hover:opacity-100">
            <MenuButton
              menuLabel={t("automations.sources.simulate")}
              align="right"
              className={`${quietButton} h-7`}
              label={t("automations.sources.simulate")}
            >
              {(close) => (
                <MenuGroup label={t("automations.prototype.only")}>
                  {source.sampleEvents.map((e, i) => (
                    <button
                      key={i}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={itemClass}
                      onClick={() => {
                        close();
                        simulate(i);
                      }}
                    >
                      {sampleWords(source, e, t)}
                    </button>
                  ))}
                </MenuGroup>
              )}
            </MenuButton>
            <MenuButton
              menuLabel={t("automations.sources.menu", { name: source.name })}
              ariaLabel={t("automations.sources.menu", { name: source.name })}
              align="right"
              className={`${quietButton} h-7 w-7 justify-center px-0`}
              label={<MoreGlyph />}
            >
              {(close) => (
                <MenuGroup>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={`${itemClass} text-critical`}
                    onClick={() => {
                      close();
                      setDialog("disconnect");
                    }}
                  >
                    {t("automations.sources.disconnect")}
                  </button>
                </MenuGroup>
              )}
            </MenuButton>
          </span>
        )}
      </span>
      {dialog === "connect" && <ConnectDialog source={source} onClose={() => setDialog(null)} />}
      {dialog === "disconnect" && (
        <DisconnectDialog source={source} onClose={() => setDialog(null)} />
      )}
    </li>
  );
}

function ConnectMenu({ sources }: { sources: AutomationSourceView[] }) {
  const { t } = useTranslation();
  const [connecting, setConnecting] = useState<AutomationSourceView | null>(null);
  const [newWebhook, setNewWebhook] = useState(false);
  const openSource = useOpenSource();
  const crms = sources.filter((s) => s.kind !== "webhook");
  return (
    <>
      <MenuButton
        menuLabel={t("automations.sources.connect")}
        align="right"
        className={primaryButton}
        label={
          <>
            {t("automations.sources.connect")}
            <Chevron />
          </>
        }
      >
        {(close) => (
          <MenuGroup>
            {crms.map((s) => (
              <button
                key={s.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={s.status === "connected"}
                className={`${itemClass} aria-disabled:text-ink-faint`}
                onClick={() => {
                  if (s.status === "connected") return;
                  close();
                  setConnecting(s);
                }}
              >
                {s.name}
                {s.status === "connected" && (
                  <span className="ml-auto text-xs">
                    {t("automations.sources.status.connected")}
                  </span>
                )}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={itemClass}
              onClick={() => {
                close();
                setNewWebhook(true);
              }}
            >
              {t("automations.sources.incomingWebhook")}
            </button>
          </MenuGroup>
        )}
      </MenuButton>
      {connecting && <ConnectDialog source={connecting} onClose={() => setConnecting(null)} />}
      {newWebhook && (
        <NewWebhookDialog onClose={() => setNewWebhook(false)} onCreated={(id) => openSource(id)} />
      )}
    </>
  );
}

/** `#/automations/sources`: solo con `integrations.manage`. */
export function SourcesPage() {
  const { t } = useTranslation();
  const perms = useAutomationPerms();
  const sources = useAutomationSources();
  const search = useSearch({ strict: false }) as { source?: string };
  if (!perms.integrations) return <NotVisible what="page" />;
  const list = sources.data ?? [];
  return (
    <section className="flex min-h-full flex-col pb-16 pl-8">
      <div className="flex w-full max-w-[960px] flex-col pr-8">
        <header className="page-header flex shrink-0 flex-col gap-1.5 pb-5 [--page-header-pr:32px] [--page-header-pt:32px]">
          <h1 className="text-2xl font-semibold text-ink">{t("automations.sources.title")}</h1>
          <p className="text-md text-ink-muted">{t("automations.sources.intro")}</p>
        </header>
        <section aria-labelledby="connected-sources" className="border-t border-rule pt-5 pb-7">
          <div className="flex items-center gap-3 pb-3">
            <h2 id="connected-sources" className="text-xl font-semibold text-ink">
              {t("automations.sources.connected")}
            </h2>
            <span className="ml-auto">{list.length > 0 && <ConnectMenu sources={list} />}</span>
          </div>
          {sources.isError ? (
            <div role="alert" className="flex items-center gap-3 border-t border-rule py-3">
              <p className="text-md text-ink">{t("automations.errors.loadSources")}</p>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => void sources.refetch()}
              >
                {t("automations.actions.retry")}
              </button>
            </div>
          ) : sources.data === undefined ? (
            <PageSkeleton rows={6} />
          ) : list.length === 0 ? (
            <div className="flex flex-col items-start gap-2 border-t border-rule py-4">
              <p className="text-md text-ink">{t("automations.sources.empty")}</p>
            </div>
          ) : (
            <ul
              aria-label={t("automations.sources.connected")}
              onKeyDown={rowKeys("[data-source-row]")}
              className="border-t border-rule"
            >
              {list.map((s) => (
                <SourceRow key={s.id} source={s} open={search.source === s.id} />
              ))}
            </ul>
          )}
        </section>
        <ClientLinks />
      </div>
    </section>
  );
}
