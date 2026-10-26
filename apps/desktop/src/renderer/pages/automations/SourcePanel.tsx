import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAutomationRuns,
  useAutomations,
  useAutomationSources,
  usePeople,
  useSessionPersonId,
} from "../../data/queries";
import type { AutomationSourceView, DataField } from "../../data/types";
import {
  DetailPanel,
  DOCKED_PANEL_QUERY,
  forcesOverlay,
  type DetailPanelMode,
} from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { Avatar } from "../../tasks-ui/PersonChip";
import { primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { clientOf, shortDate } from "./format";
import { SourceGlyph, WarningGlyph } from "./glyphs";
import {
  AutomationStatusWord,
  PrototypeBox,
  codeClass,
  textLink,
  useAutomationPerms,
} from "./shared";
import { usersOf, sampleWords, webhookAddress, useSimulate } from "./sourceHelpers";
import { ConnectDialog, DisconnectDialog } from "./SourceDialogs";

// Il pannello di una sorgente (shape automation-sources.md §6): stato, chi
// l'ha collegata, i dati che porta (per un webhook indirizzo, esempio e
// campi), chi la usa, gli eventi recenti, «Simulate an event».

export function StatusWord({ status }: { status: AutomationSourceView["status"] }) {
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

export function FieldRows({ fields, depth = 0 }: { fields: DataField[]; depth?: number }) {
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

export function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-rule px-4 py-3">
      <h3 className="heading-group">{title}</h3>
      {children}
    </section>
  );
}

export function SourcePanel({ source }: { source: AutomationSourceView }) {
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
