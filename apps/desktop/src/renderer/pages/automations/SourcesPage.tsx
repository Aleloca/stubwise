import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAutomationRuns,
  useAutomations,
  useAutomationSources,
  useConnectAutomationSource,
  useDisconnectAutomationSource,
  useFetchAutomationRuns,
  usePeople,
  useSessionPersonId,
  useSimulateSourceEvent,
} from "../../data/queries";
import type { AutomationSourceView, DataField } from "../../data/types";
import {
  DetailPanel,
  DOCKED_PANEL_QUERY,
  forcesOverlay,
  type DetailPanelMode,
} from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { Dialog } from "../../tasks-ui/Dialog";
import { MenuGroup, MenuNote, itemClass } from "../../tasks-ui/Menu";
import { PageSkeleton } from "../../tasks-ui/PageStates";
import { Avatar } from "../../tasks-ui/PersonChip";
import { useToast } from "../../tasks-ui/Toast";
import { rowKeys } from "../home/blocks/BlockSection";
import {
  MenuButton,
  Chevron,
  dangerSolidButton,
  primaryButton,
  quietButton,
  secondaryButton,
} from "../tasks/controls";
import { ClientLinks } from "./ClientLinks";
import { clientOf, shortDate } from "./format";
import { MoreGlyph, SourceGlyph, WarningGlyph } from "./glyphs";
import {
  AutomationStatusWord,
  NotVisible,
  PrototypeBox,
  codeClass,
  textLink,
  useAutomationPerms,
} from "./shared";

// Le sorgenti (shape automation-sources.md): un quadro dei contatori — ogni
// sorgente con la sua spia in parola, chi l'ha collegata e cosa alimenta —
// e il registro cliente → progetto. Solo con `integrations.manage` ([A 2]):
// senza, la pagina risponde come una che non esiste (R-G5). I connettori sono
// simulati e lo si dice una volta, nel riquadro «Prototype only».

type Automations = ReturnType<typeof useAutomations>["data"];

/** Le automazioni che partono da una sorgente (dalla versione pubblicata, o dall'ultima). */
function usersOf(source: AutomationSourceView, automations: Automations) {
  return (automations ?? []).filter((a) => {
    const v = a.versions.filter((x) => x.publishedAt !== null).at(-1) ?? a.versions.at(-1)!;
    return v.flow.trigger.kind === "source" && v.flow.trigger.sourceId === source.id;
  });
}

/** Un evento d'esempio in parole: «Deal won · Cantina Bellavista Srl · CRM, Centralino AI». */
function sampleWords(
  source: AutomationSourceView,
  e: Record<string, unknown>,
  t: (k: string, o?: Record<string, unknown>) => string,
) {
  const client = clientOf(e) ?? "";
  const deal = e.trattativa as { prodotti?: { nome?: string }[] } | undefined;
  const products = deal?.prodotti
    ?.map((p) => p.nome)
    .filter(Boolean)
    .join(", ");
  const request = (e.richiesta as { funzione?: string } | undefined)?.funzione;
  const kind =
    source.kind === "webhook"
      ? t("automations.sources.webhookEvent")
      : t("automations.sources.dealWon");
  return [kind, client, products ?? request].filter(Boolean).join(" · ");
}

/** L'indirizzo (finto) di un webhook in arrivo. */
const webhookAddress = (id: string) =>
  `https://stubwise.example/hooks/in/${id.replace(/^src-/, "")}-7f3a9c`;

function useOpenSource() {
  const navigate = useNavigate();
  return (id: string | undefined) =>
    void navigate({
      to: "/automations/sources",
      search: ((prev: Record<string, unknown>) => ({ ...prev, src: id })) as never,
    });
}

/** «Simulate an event»: manda un evento d'esempio e dice quali esecuzioni sono partite. */
function useSimulate(source: AutomationSourceView) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const simulate = useSimulateSourceEvent();
  const fetchRuns = useFetchAutomationRuns();
  const automations = useAutomations().data;
  const paused = usersOf(source, automations).find((a) => a.status === "paused");
  return (sampleIndex: number) =>
    simulate.mutate(
      { sourceId: source.id, sampleIndex },
      {
        onSuccess: async (ids) => {
          const runs = await fetchRuns(ids);
          if (runs.length === 0) {
            toast.show(
              paused
                ? `${t("automations.toast.eventNone")} · ${t("automations.toast.eventPaused", { code: paused.code })}`
                : t("automations.toast.eventNone"),
            );
          } else if (runs.length === 1) {
            const r = runs[0]!;
            toast.show(t("automations.toast.eventStarted", { code: r.code }), {
              action: {
                label: t("automations.actions.open"),
                run: () =>
                  void navigate({
                    to: "/automations/$code/runs/$n",
                    params: { code: r.automationCode, n: String(r.n) },
                  }),
              },
            });
          } else {
            toast.show(t("automations.toast.eventStartedMany", { count: runs.length }), {
              action: {
                label: t("automations.actions.show"),
                run: () => void navigate({ to: "/automations", search: { view: "runs" } as never }),
              },
            });
          }
        },
        onError: () => toast.error(t("automations.toast.eventError")),
      },
    );
}

function StatusWord({ status }: { status: AutomationSourceView["status"] }) {
  const { t } = useTranslation();
  return (
    <span data-source-status={status} className="inline-flex items-center gap-1.5 text-sm text-ink">
      {status === "connected" ? (
        <span aria-hidden="true" className="grid size-4 place-items-center">
          <span className="size-2 rounded-full bg-positive" />
        </span>
      ) : status === "expired" ? (
        <WarningGlyph />
      ) : (
        <span aria-hidden="true" className="grid size-4 place-items-center">
          <span className="size-2 rounded-full border border-ink-faint" />
        </span>
      )}
      {t(`automations.sources.status.${status}`)}
    </span>
  );
}

export function ConnectDialog({
  source,
  onClose,
}: {
  source: AutomationSourceView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useSessionPersonId();
  const name = usePeople().data?.find((p) => p.id === me)?.name ?? "";
  const connect = useConnectAutomationSource();
  return (
    <Dialog
      title={t(
        source.status === "expired"
          ? "automations.sources.reconnectTitle"
          : "automations.sources.connectTitle",
        { name: source.name },
      )}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={connect.isPending}
            onClick={() =>
              connect.mutate(source.id, {
                onSuccess: () => {
                  onClose();
                  toast.show(t("automations.toast.connected", { name: source.name }));
                },
                onError: () =>
                  toast.error(t("automations.toast.connectError", { name: source.name })),
              })
            }
          >
            {source.status === "expired"
              ? t("automations.sources.reconnect")
              : t("automations.sources.connect")}
          </button>
        </>
      }
    >
      <PrototypeBox>
        <p className="text-sm text-ink">{t("automations.sources.simulated")}</p>
      </PrototypeBox>
      <p className="text-md text-ink">
        {source.kind === "webhook"
          ? t("automations.sources.readsWebhook")
          : t("automations.sources.readsCrm", { name: source.name })}
      </p>
      <p className="text-sm text-ink-muted">{t("automations.sources.asYou", { name })}</p>
    </Dialog>
  );
}

function DisconnectDialog({
  source,
  onClose,
}: {
  source: AutomationSourceView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const automations = useAutomations().data;
  const active = usersOf(source, automations).filter((a) => a.status === "active");
  const disconnect = useDisconnectAutomationSource();
  return (
    <Dialog
      title={t("automations.sources.disconnectTitle", { name: source.name })}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={dangerSolidButton}
            disabled={disconnect.isPending}
            onClick={() =>
              disconnect.mutate(source.id, {
                onSuccess: () => {
                  onClose();
                  toast.show(t("automations.toast.disconnected", { name: source.name }));
                },
                onError: () =>
                  toast.error(t("automations.toast.connectError", { name: source.name })),
              })
            }
          >
            {t("automations.sources.disconnect")}
          </button>
        </>
      }
    >
      {active.length > 0 ? (
        <p data-affected className="text-md text-ink">
          {t("automations.sources.affects", {
            count: active.length,
            name: source.name,
            list: active.map((a) => `${a.code} ${a.name}`).join(", "),
          })}
        </p>
      ) : (
        <p className="text-md text-ink">
          {t("automations.sources.affectsNone", { name: source.name })}
        </p>
      )}
      <p className="text-sm text-ink-muted">
        {t("automations.sources.runsContinue")} {t("automations.sources.eventsLost")}
      </p>
    </Dialog>
  );
}

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
      ? t("automations.sources.expiredLine")
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
          <button
            type="button"
            className={`${secondaryButton} h-7`}
            onClick={() => setDialog("connect")}
          >
            {source.status === "expired"
              ? t("automations.sources.reconnect")
              : t("automations.sources.connect")}
          </button>
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
            {/* TODO(area 7, follow-up): creare un webhook nuovo non ha ancora una scrittura nel livello dati. */}
            <MenuNote>{t("automations.sources.newWebhookLater")}</MenuNote>
          </MenuGroup>
        )}
      </MenuButton>
      {connecting && <ConnectDialog source={connecting} onClose={() => setConnecting(null)} />}
    </>
  );
}

/** `#/automations/sources`: solo con `integrations.manage`. */
export function SourcesPage() {
  const { t } = useTranslation();
  const perms = useAutomationPerms();
  const sources = useAutomationSources();
  const search = useSearch({ strict: false }) as { src?: string };
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
                <SourceRow key={s.id} source={s} open={search.src === s.id} />
              ))}
            </ul>
          )}
        </section>
        <ClientLinks />
      </div>
    </section>
  );
}

function FieldRows({ fields, depth = 0 }: { fields: DataField[]; depth?: number }) {
  const { t } = useTranslation();
  return (
    <>
      {fields.map((f) => (
        <li key={f.key}>
          <p
            title={f.key}
            className="flex min-h-7 items-baseline gap-2 text-md text-ink"
            style={{ paddingLeft: depth * 16 }}
          >
            {depth > 0 && (
              <span aria-hidden="true" className="text-ink-faint">
                →
              </span>
            )}
            {f.label}
            <span className="text-xs text-ink-muted">{t(`automations.fieldType.${f.type}`)}</span>
          </p>
          {f.of && (
            <ul>
              <FieldRows fields={f.of} depth={depth + 1} />
            </ul>
          )}
        </li>
      ))}
    </>
  );
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-rule px-4 py-3">
      <h3 className="heading-group">{title}</h3>
      {children}
    </section>
  );
}

function SourcePanel({ source }: { source: AutomationSourceView }) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const automations = useAutomations().data;
  const runs = useAutomationRuns().data ?? [];
  const simulate = useSimulate(source);
  const [dialog, setDialog] = useState<"connect" | "disconnect" | null>(null);
  const users = usersOf(source, automations);
  const connector = people?.find((p) => p.id === source.connectedById);
  const recent = runs
    .filter((r) => r.origin === "source" && users.some((a) => a.id === r.automationId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 5);
  const expiredUsers = users.filter((a) => a.status === "active");
  return (
    <div data-source-panel={source.id} className="flex flex-col">
      <header className="flex flex-col gap-0.5 px-4 pt-4 pb-3">
        <h2 className="flex items-center gap-2 text-xl font-semibold text-ink">
          <SourceGlyph kind={source.kind} />
          {source.name}
        </h2>
        <p className="text-xs text-ink-muted">
          {source.kind === "webhook"
            ? t("automations.sources.incomingWebhook")
            : t("automations.sources.crmOf", { name: source.name })}
        </p>
        <span className="pt-1">
          <StatusWord status={source.status} />
        </span>
      </header>
      {source.status !== "connected" && (
        <div
          role="status"
          className="mx-4 mb-3 flex flex-col gap-2 rounded-md border border-rule px-3 py-2.5"
        >
          <p className="flex items-start gap-2 text-sm text-ink">
            <WarningGlyph />
            {expiredUsers.length === 0
              ? t(
                  source.status === "expired"
                    ? "automations.sources.expiredNone"
                    : "automations.sources.disconnectedNone",
                )
              : t(
                  source.status === "expired"
                    ? "automations.sources.expiredBanner"
                    : "automations.sources.disconnectedBanner",
                  {
                    codes: expiredUsers.map((a) => a.code).join(", "),
                    count: expiredUsers.length,
                  },
                )}
          </p>
          <button
            type="button"
            className={`${primaryButton} self-start`}
            onClick={() => setDialog("connect")}
          >
            {source.status === "expired"
              ? t("automations.sources.reconnect")
              : t("automations.sources.connect")}
          </button>
        </div>
      )}
      <PanelSection title={t("automations.sources.connectedBy")}>
        <p className="flex items-center gap-2 text-md text-ink">
          <Avatar person={connector} />
          {connector?.name ?? "—"}
        </p>
      </PanelSection>
      {source.kind === "webhook" && (
        <>
          <PanelSection title={t("automations.sources.address")}>
            <p className="truncate text-sm text-ink" title={webhookAddress(source.id)}>
              {webhookAddress(source.id)}
            </p>
            <p className="text-xs text-ink-muted">{t("automations.sources.postHint")}</p>
          </PanelSection>
          <PanelSection title={t("automations.sources.example")}>
            <pre
              data-webhook-example
              className="max-h-80 overflow-auto rounded-md border border-rule p-2 font-mono text-xs text-ink"
            >
              {JSON.stringify(source.sampleEvents[0] ?? {}, null, 2)}
            </pre>
          </PanelSection>
        </>
      )}
      <PanelSection
        title={
          source.kind === "webhook"
            ? t("automations.sources.fields")
            : t("automations.sources.events")
        }
      >
        {source.kind !== "webhook" && (
          <p className="text-sm text-ink">{t("automations.sources.dealWon")}</p>
        )}
        <ul aria-label={t("automations.sources.fields")}>
          <FieldRows fields={source.fields} />
        </ul>
        {source.kind === "webhook" && (
          <p className="text-xs text-ink-muted">{t("automations.sources.fieldsHint")}</p>
        )}
      </PanelSection>
      <PanelSection title={t("automations.sources.usedByTitle")}>
        {users.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("automations.sources.notUsed")}</p>
        ) : (
          <ul>
            {users.map((a) => (
              <li key={a.id} className="flex min-h-8 items-center gap-2">
                <Link
                  to="/automations/$code"
                  params={{ code: a.code }}
                  className={`${textLink} flex min-w-0 items-baseline gap-2`}
                >
                  <span className={codeClass}>{a.code}</span>
                  <span className="truncate text-sm">{a.name}</span>
                </Link>
                <span className="ml-auto shrink-0">
                  <AutomationStatusWord status={a.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
      <PanelSection title={t("automations.sources.recent")}>
        {recent.length === 0 ? (
          <p className="text-sm text-ink-muted">—</p>
        ) : (
          <ul>
            {recent.map((r) => (
              <li key={r.id} className="flex min-h-8 items-center gap-2 text-sm">
                <span className="num text-ink-muted">{shortDate(r.startedAt, i18n.language)}</span>
                <span className="min-w-0 truncate text-ink">{clientOf(r.event) ?? r.title}</span>
                <Link
                  to="/automations/$code/runs/$n"
                  params={{ code: r.automationCode, n: String(r.n) }}
                  className={`${textLink} num ml-auto shrink-0 font-semibold`}
                >
                  {r.code}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
      <div className="px-4 py-3">
        <PrototypeBox label={t("automations.sources.simulate")}>
          {source.status !== "connected" ? (
            <p className="text-sm text-ink-muted">
              {t("automations.sources.simulateOff", { name: source.name })}
            </p>
          ) : (
            <ul className="flex flex-col">
              {source.sampleEvents.map((e, i) => (
                <li key={i} className="flex min-h-8 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {sampleWords(source, e, t)}
                  </span>
                  <button
                    type="button"
                    className={`${secondaryButton} h-7`}
                    onClick={() => simulate(i)}
                  >
                    {t("automations.sources.send")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PrototypeBox>
      </div>
      {source.status !== "disconnected" && (
        <div className="px-4 pb-4">
          <button
            type="button"
            className={`${quietButton} text-critical`}
            onClick={() => setDialog("disconnect")}
          >
            {t("automations.sources.disconnect")}
          </button>
        </div>
      )}
      {dialog === "connect" && <ConnectDialog source={source} onClose={() => setDialog(null)} />}
      {dialog === "disconnect" && (
        <DisconnectDialog source={source} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

/**
 * Il pannello di una sorgente (`#/automations/sources?src=<id>`), montato
 * nell'`AppLayout` accanto alla pagina: affiancato da 1200 px, sovrapposto
 * sotto. Cambiare persona lo chiude: niente della sorgente resta a schermo.
 */
export function SourceDetailHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { src?: string };
  const onPage = useRouterState({ select: (s) => s.location.pathname === "/automations/sources" });
  const wide = useMediaQuery(DOCKED_PANEL_QUERY);
  const overlayOnly = useRouterState({ select: (s) => forcesOverlay(s.location.pathname) });
  const mode: DetailPanelMode = wide && !overlayOnly ? "docked" : "overlay";
  const perms = useAutomationPerms();
  const personId = useSessionPersonId();
  const sources = useAutomationSources().data;
  const close = useCallback(() => {
    void navigate({
      to: "/automations/sources",
      search: ((prev: Record<string, unknown>) => ({ ...prev, src: undefined })) as never,
    });
  }, [navigate]);
  const [viewer, setViewer] = useState(personId);
  useEffect(() => {
    if (viewer !== personId) {
      setViewer(personId);
      if (search.src) close();
    }
  }, [viewer, personId, search.src, close]);
  if (!onPage || !search.src || !perms.integrations || viewer !== personId) return null;
  const source = sources?.find((s) => s.id === search.src);
  if (!source) return null;
  return (
    <DetailPanel
      mode={mode}
      label={t("automations.sources.panel", { name: source.name })}
      onClose={close}
    >
      <SourcePanel key={source.id} source={source} />
    </DetailPanel>
  );
}
