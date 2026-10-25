import { useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { graphJsonOf } from "../../domain/docs";
import { useGraphAction } from "../../data/queries";
import type { DocSpaceView, GraphActionKind, GraphCommunity } from "../../data/types";
import { formatDate } from "../../notifications/time";
import { itemClass } from "../../tasks-ui/Menu";
import { copyText, downloadText } from "../../tasks-ui/exportFile";
import { useToast } from "../../tasks-ui/Toast";
import { WorkingRing } from "../claude/conversation/parts";
import { MoreIcon, ghostButton, smallSecondary } from "../task/parts";
import { MenuButton, primaryButton } from "../tasks/controls";
import { DocsGroup, useSpace } from "./parts";

// Il grafo del codice del repository (graphify; shape docs.md §5, R-H1).
// Stati: spento (spiegazione; «Enable it in the repository» con
// `repos.manage` lo accende e lo costruisce, gli altri chiedono a un
// maintainer), mai costruito, in coda/in corso (si aggiorna da solo), fallito
// (motivo + «Retry»), pronto: conteggi, «Updated on push», il grafo
// interattivo delle comunità (nomi scritti dall'AI), l'elenco, il
// `graph.json` e il comando da copiare. Le azioni stanno nel «⋯».

const fmt = (n: number, language: string) => new Intl.NumberFormat(language).format(n);

export function DocGraph() {
  const { t } = useTranslation();
  const { space } = useSpace();
  const graph = space.graph;
  const manage = space.permissions.manageRepository;
  const withMenu = manage && (graph.status === "ready" || graph.status === "failed");
  return (
    <article className="event-enter flex flex-col">
      <header className="flex items-start gap-4 pt-8">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h1 className="text-2xl font-semibold text-ink">{t("docs.graph.title")}</h1>
          <p className="text-sm text-ink-muted">{space.name}</p>
        </div>
        {withMenu && <GraphMenu space={space} />}
      </header>
      <GraphBody space={space} />
    </article>
  );
}

function useAction(space: DocSpaceView) {
  const { t } = useTranslation();
  const toast = useToast();
  const action = useGraphAction();
  const run = (kind: GraphActionKind, onDone?: () => void) =>
    action.mutate(
      { repositoryId: space.repositoryId, kind },
      { onSuccess: onDone, onError: () => toast.error(t("docs.graph.actionFailed")) },
    );
  return { run, busy: action.isPending };
}

/** Uno stato senza grafo: titolo, due frasi, l'azione (o a chi chiedere). */
function StateBlock({
  title,
  body,
  action,
  live = false,
}: {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  live?: boolean;
}) {
  return (
    <div
      aria-live={live ? "polite" : undefined}
      className="flex max-w-[72ch] flex-col items-start gap-2 pt-8"
    >
      <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">{title}</h2>
      {body && <p className="text-md text-ink-muted">{body}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

function GraphBody({ space }: { space: DocSpaceView }) {
  const { t } = useTranslation();
  const { run, busy } = useAction(space);
  const graph = space.graph;
  const manage = space.permissions.manageRepository;
  const ask = (key: string) => <p className="text-md text-ink">{t(key)}</p>;
  const button = (label: string) => (
    <button type="button" disabled={busy} className={primaryButton} onClick={() => run("generate")}>
      {label}
    </button>
  );

  switch (graph.status) {
    case "disabled":
      return (
        <StateBlock
          title={t("docs.graph.disabledTitle")}
          body={t("docs.graph.disabledBody")}
          action={manage ? button(t("docs.graph.enable")) : ask("docs.graph.askEnable")}
        />
      );
    case "never":
      return (
        <StateBlock
          title={t("docs.graph.neverTitle")}
          body={t("docs.graph.neverBody")}
          action={manage ? button(t("docs.graph.generate")) : ask("docs.graph.askBuild")}
        />
      );
    case "queued":
    case "running":
      return (
        <StateBlock
          live
          title={
            <>
              <WorkingRing size={12} />
              {t(`docs.graph.${graph.status}`)}
            </>
          }
          body={t("docs.graph.liveNote")}
        />
      );
    case "failed":
      return (
        <StateBlock
          title={t("docs.graph.failedTitle")}
          body={graph.reason ? t(`docs.graph.reasons.${graph.reason}`) : undefined}
          action={manage ? button(t("docs.graph.retry")) : ask("docs.graph.askRetry")}
        />
      );
    case "ready":
      return <ReadyGraph space={space} />;
  }
}

function GraphMenu({ space }: { space: DocSpaceView }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { run } = useAction(space);
  const pr = space.graph.setupPr;
  const item = (label: string, onSelect: () => void) => (
    <button key={label} type="button" role="menuitem" className={itemClass} onClick={onSelect}>
      {label}
    </button>
  );
  return (
    <MenuButton
      menuLabel={t("docs.graph.actions")}
      ariaLabel={t("docs.graph.actions")}
      title={t("docs.graph.actions")}
      align="right"
      className={`${ghostButton} h-8 w-8 justify-center px-0 aria-expanded:bg-ink/8`}
      label={<MoreIcon />}
    >
      {(close) => [
        item(t("docs.graph.regenerate"), () => {
          close();
          run("regenerate");
        }),
        item(t("docs.graph.rebuild"), () => {
          close();
          run("rebuild");
        }),
        item(pr ? t("docs.graph.viewSetupPr") : t("docs.graph.openSetupPr"), () => {
          close();
          if (pr) toast.show(t("docs.graph.setupPrIs", { url: pr.url }));
          else run("setup_pr", () => toast.show(t("docs.graph.setupPrOpened")));
        }),
      ]}
    </MenuButton>
  );
}

function ReadyGraph({ space }: { space: DocSpaceView }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const graph = space.graph;
  const report = graph.report ?? [];
  const command = `graphify query "how does ${(report[0]?.name ?? "the code").toLowerCase()} work"`;
  const download = () => {
    downloadText("graph.json", graphJsonOf(space.name, graph), "application/json");
    toast.show(t("docs.graph.downloaded"));
  };
  const copy = () =>
    copyText(command).then(
      () => toast.show(t("docs.graph.copied")),
      () => toast.error(t("docs.graph.copyFailed")),
    );

  return (
    <>
      <p className="num flex flex-wrap items-baseline gap-x-2 pt-4 text-md text-ink">
        <span>
          {t("docs.graph.counts", {
            nodes: fmt(graph.nodes ?? 0, i18n.language),
            edges: fmt(graph.edges ?? 0, i18n.language),
            communities: fmt(graph.communities ?? report.length, i18n.language),
          })}
        </span>
      </p>
      <p className="pt-1 text-sm text-ink-muted">
        <span>{t("docs.graph.updatedOnPush")}</span>
        {graph.updatedAt && (
          <span className="num">
            {" "}
            · {t("docs.graph.lastBuilt", { date: formatDate(graph.updatedAt, i18n.language) })}
          </span>
        )}
      </p>

      <CommunityGraph name={space.name} report={report} />

      <DocsGroup
        title={t("docs.graph.communities")}
        action={<span className="text-xs text-ink-muted">{t("docs.graph.aiLabels")}</span>}
      >
        <ul aria-label={t("docs.graph.communities")} className="border-t border-rule">
          {report.map((c) => (
            <li key={c.id} className="flex flex-col gap-0.5 border-b border-rule px-2 py-2.5">
              <span className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate text-md font-semibold text-ink">
                  {c.name}
                </span>
                <span className="num shrink-0 text-sm text-ink-faint">
                  {t("docs.graph.nodes", { count: c.size })}
                </span>
              </span>
              <span className="max-w-[72ch] text-sm text-ink-muted">{c.summary}</span>
            </li>
          ))}
        </ul>
      </DocsGroup>

      <div className="flex flex-col items-start gap-3 pt-7">
        <button type="button" className={smallSecondary} onClick={download}>
          {t("docs.graph.download")}
        </button>
        <div className="flex w-full flex-col gap-1.5">
          <span className="text-xs text-ink-muted">{t("docs.graph.fromTerminal")}</span>
          <div className="flex w-full min-w-0 items-center gap-2 rounded-md border border-rule bg-ink/4 py-1.5 pr-1.5 pl-3">
            <code className="font-code min-w-0 flex-1 truncate text-sm text-ink" title={command}>
              {command}
            </code>
            <button type="button" className={smallSecondary} onClick={() => void copy()}>
              {t("docs.graph.copyCommand")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

const W = 640;
const H = 340;

/**
 * Il grafo delle comunità: una per cerchio (grande quanto la comunità), gli
 * archi fra comunità vicine; aprirne una (clic, Invio, Spazio) mostra i suoi
 * nodi più collegati attorno. Inchiostro soltanto: le comunità non sono
 * reparti né stati.
 */
function CommunityGraph({ name, report }: { name: string; report: GraphCommunity[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const max = Math.max(1, ...report.map((c) => c.size));
  const n = report.length;
  const at = new Map(
    report.map((c, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, n);
      const single = n === 1;
      return [
        c.id,
        {
          x: single ? W / 2 : W / 2 + Math.cos(angle) * 210,
          y: single ? H / 2 : H / 2 + Math.sin(angle) * 112,
          r: 12 + 16 * Math.sqrt(c.size / max),
          angle,
        },
      ];
    }),
  );
  const edges = report.flatMap((c) =>
    c.links.filter((l) => l > c.id && at.has(l)).map((l) => [c.id, l] as const),
  );
  const onKey = (e: KeyboardEvent<SVGGElement>, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle(id);
    }
  };

  return (
    <figure
      role="group"
      aria-label={t("docs.graph.label", { name })}
      className="mt-6 flex flex-col gap-2 border-y border-rule py-4"
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible">
        {edges.map(([a, b]) => {
          const p = at.get(a)!;
          const q = at.get(b)!;
          return (
            <line
              key={`${a}-${b}`}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              className="stroke-ink/20"
              strokeWidth={1}
            />
          );
        })}
        {report.map((c) => {
          const p = at.get(c.id)!;
          const expanded = open.has(c.id);
          return (
            <g
              key={c.id}
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              aria-label={`${c.name}, ${t("docs.graph.nodes", { count: c.size })}`}
              onClick={() => toggle(c.id)}
              onKeyDown={(e) => onKey(e, c.id)}
              className="cursor-pointer outline-none [&:focus-visible>circle.hub]:stroke-focus [&:focus-visible>circle.hub]:stroke-2"
            >
              {expanded &&
                c.nodes.map((node, i) => {
                  const spread = Math.PI / 2.2;
                  const a =
                    p.angle +
                    (c.nodes.length === 1 ? 0 : -spread / 2 + (i * spread) / (c.nodes.length - 1));
                  const d = p.r + 34;
                  const x = p.x + Math.cos(a) * d;
                  const y = p.y + Math.sin(a) * d;
                  const right = Math.cos(a) >= 0;
                  return (
                    <g key={node} className="event-enter">
                      <line
                        x1={p.x}
                        y1={p.y}
                        x2={x}
                        y2={y}
                        className="stroke-ink/25"
                        strokeWidth={1}
                      />
                      <circle cx={x} cy={y} r={3.5} className="fill-ink" />
                      <text
                        x={x + (right ? 7 : -7)}
                        y={y + 4}
                        textAnchor={right ? "start" : "end"}
                        className="fill-ink-muted stroke-ground stroke-[4px] text-[12px] [paint-order:stroke]"
                      >
                        {node}
                      </text>
                    </g>
                  );
                })}
              {/* Il fondo pieno: gli archi passano sotto, non attraverso. */}
              <circle cx={p.x} cy={p.y} r={p.r} className="fill-ground" />
              <circle
                className={`hub stroke-ink/40 transition-colors duration-[var(--duration-fast)] ${expanded ? "fill-ink/16" : "fill-ink/6 hover:fill-ink/12"}`}
                cx={p.x}
                cy={p.y}
                r={p.r}
                strokeWidth={1}
              />
              <text
                x={p.x}
                y={p.y + p.r + 15}
                textAnchor="middle"
                className="fill-ink stroke-ground stroke-[4px] text-[12px] font-semibold [paint-order:stroke]"
              >
                {c.name}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="text-xs text-ink-muted">{t("docs.graph.hint")}</figcaption>
    </figure>
  );
}
