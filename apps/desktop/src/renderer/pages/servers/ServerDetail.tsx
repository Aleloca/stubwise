import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useServer } from "../../data/queries";
import type { MetricRange, ServerDetail as Detail } from "../../data/servers";
import { PageError } from "../../tasks-ui/PageStates";
import { ChecksPanel } from "./ChecksPanel";
import { DisksPanel } from "./DisksPanel";
import { healthParts, lastReport, whereLine } from "./format";
import { HealthGlyph } from "./glyphs";
import { MetricsCharts, RANGES } from "./MetricsCharts";
import { NowBox, showsNow } from "./NowBox";
import { ServerSettings } from "./ServerSettings";
import { ServicesTable } from "./ServicesTable";
import { SimulatePanel } from "./SimulatePanel";
import { SshAccessPanel } from "./SshAccessPanel";
import { ThresholdsPanel } from "./ThresholdsPanel";

// Il dettaglio di un server (`#/p/ACQ/servers/SRV-1`, shape servers.md §3):
// una pagina intera che scorre, aperta dal riquadro «Now» e ordinata per
// domanda — com'è andato (grafici) → cosa gira (servizi, dischi) → cosa si
// controlla (controlli, soglie) → chi può entrare (accesso SSH) →
// impostazioni. L'indice agganciato porta alle parti (link, non schede).
// `?range=` l'intervallo dei grafici, `?check=` il controllo selezionato,
// `?section=` la parte da portare in vista. Un server inesistente,
// invisibile o di un altro progetto risponde allo stesso modo (R-G5).
// Dall'Amministrazione (`#/admin/servers/SRV-1`, area 9b) `projectCode` è
// nullo: la stessa pagina, con «← Servers» verso l'Amministrazione e
// nessun progetto «di qui»; ogni server elencato lì si apre (ruling T7 I2).

type PartId = "charts" | "services" | "disks" | "checks" | "access" | "thresholds" | "settings";

/** «← Servers»: la sezione del progetto, o l'Amministrazione (`projectCode` nullo). */
export function BackToServers({
  projectCode,
  className,
}: {
  projectCode: string | null;
  className: string;
}) {
  const { t } = useTranslation();
  return projectCode ? (
    <Link
      to="/p/$code/$section"
      params={{ code: projectCode, section: "servers" }}
      className={className}
    >
      {t("servers.backToList")}
    </Link>
  ) : (
    <Link to="/admin/$section" params={{ section: "servers" }} className={className}>
      {t("servers.backToList")}
    </Link>
  );
}

function NotFound({ projectCode }: { projectCode: string | null }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col items-start gap-3 p-8">
      <h1 className="text-2xl font-semibold text-ink">{t("servers.notFound")}</h1>
      <BackToServers
        projectCode={projectCode}
        className="rounded-sm text-sm text-ink underline-offset-4 hover:underline"
      />
    </section>
  );
}

/** Testata e cinque riquadri grafico finti: la forma vera della pagina. */
function DetailSkeleton() {
  const { t } = useTranslation();
  return (
    <section aria-busy="true" className="skeleton-breathe flex max-w-[1120px] flex-col gap-4 p-8">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <span className="h-3 w-24 rounded-sm bg-ink/8" />
      <span className="h-7 w-1/3 rounded-sm bg-ink/8" />
      <span className="h-3 w-2/3 rounded-sm bg-ink/6" />
      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="h-[170px] rounded-md bg-ink/6" />
        ))}
      </div>
    </section>
  );
}

const typing = (el: Element | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

function Page({ server, projectCode }: { server: Detail; projectCode: string | null }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    range?: string;
    check?: string;
    section?: string;
    task?: string;
  };
  const range: MetricRange = (RANGES as readonly string[]).includes(search.range ?? "")
    ? (search.range as MetricRange)
    : "24h";
  const check = server.checks.find((c) => c.id === search.check) ?? null;
  const setSearch = (patch: Record<string, string | undefined>) =>
    void navigate({
      to: ".",
      search: ((prev: Record<string, unknown>) => ({ ...prev, ...patch })) as never,
      replace: true,
    });
  const parts: PartId[] = [
    "charts",
    "services",
    "disks",
    "checks",
    "access",
    "thresholds",
    ...(server.canManage ? (["settings"] as const) : []),
  ];
  const [current, setCurrent] = useState<PartId>("charts");

  // `?section=` porta la parte in vista all'arrivo.
  useEffect(() => {
    const id = search.section;
    if (id) document.getElementById(`server-${id}`)?.scrollIntoView?.({ block: "start" });
  }, [search.section]);

  // La parte in vista (la prima che tocca il bordo alto) si sottolinea nell'indice.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          seen.set((e.target as HTMLElement).dataset.part ?? "", e.isIntersecting);
        const first = parts.find((p) => seen.get(p));
        if (first) setCurrent(first);
      },
      { rootMargin: "-40px 0px -60% 0px" },
    );
    for (const p of parts) {
      const el = document.getElementById(`server-${p}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
    // Le parti cambiano solo con `canManage`.
  }, [server.canManage]);

  // 1–5 scelgono l'intervallo (col fuoco fuori dai campi); Esc deseleziona il controllo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (typing(document.activeElement) || document.querySelector("[aria-modal='true']")) return;
      const r = /^[1-9]$/.test(e.key) ? RANGES[Number(e.key) - 1] : undefined;
      if (r) {
        e.preventDefault();
        setSearch({ range: r });
      } else if (e.key === "Escape" && search.check && !search.task) {
        // Col pannello della task aperto (dal Now) l'Esc è suo: chiude quello.
        e.preventDefault();
        setSearch({ check: undefined });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const { word } = healthParts(server.health, t, i18n.language);
  const meta = [
    server.hostname,
    server.agentVersion ? t("servers.detail.agent", { version: server.agentVersion }) : null,
    server.lastSeenAt
      ? t("servers.detail.lastReport", { when: lastReport(server.lastSeenAt, t, i18n.language) })
      : null,
    whereLine(server, t) || null,
  ].filter(Boolean);

  return (
    <section className="@container flex min-h-full flex-col pb-16 pl-8">
      <div className="flex w-full max-w-[1120px] flex-col pr-8">
        <header className="page-header flex flex-col gap-1.5 pb-3 [--page-header-pr:32px] [--page-header-pt:32px]">
          <p className="text-xs text-ink-muted">
            <BackToServers
              projectCode={projectCode}
              className="rounded-sm underline-offset-4 hover:text-ink hover:underline"
            />
          </p>
          <h1 className="flex flex-wrap items-baseline gap-x-3 text-2xl font-semibold text-ink">
            <span className="line-clamp-2 [overflow-wrap:anywhere]">{server.name}</span>
            <span className="num text-2xl font-semibold text-ink-muted">{server.code}</span>
          </h1>
          {/* Il «·» chiude l'elemento che precede: andando a capo, una riga
              non comincia mai col separatore. */}
          <p className="num flex flex-wrap items-center gap-x-1.5 text-sm text-ink-muted">
            <span className="flex items-center gap-1.5">
              <HealthGlyph health={server.health.health} />
              <span className="font-semibold text-ink">{word}</span>
              {meta.length > 0 && <span aria-hidden="true">·</span>}
            </span>
            {meta.map((m, i) => (
              <span key={m} className="flex items-center gap-1.5">
                <span>{m}</span>
                {i < meta.length - 1 && <span aria-hidden="true">·</span>}
              </span>
            ))}
          </p>
        </header>
        <nav
          aria-label={t("servers.index.label", { code: server.code })}
          className="sticky top-0 z-[2] -ml-1 flex h-8 items-center gap-1 border-b border-rule bg-ground"
        >
          {parts.map((p) => (
            <button
              key={p}
              type="button"
              aria-current={current === p ? "location" : undefined}
              onClick={() => {
                setCurrent(p);
                document.getElementById(`server-${p}`)?.scrollIntoView?.({ block: "start" });
              }}
              className="h-8 rounded-sm px-2 text-sm text-ink-muted underline-offset-[9px] transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink aria-[current=location]:text-ink aria-[current=location]:underline aria-[current=location]:decoration-2"
            >
              {t(`servers.index.${p}`)}
            </button>
          ))}
        </nav>
        <div className="flex flex-col gap-10 pt-6">
          {showsNow(server) && <NowBox server={server} />}
          <MetricsCharts
            server={server}
            range={range}
            setRange={(r) => setSearch({ range: r })}
            check={check}
            clearCheck={() => setSearch({ check: undefined })}
          />
          <ServicesTable services={server.services} />
          <DisksPanel disks={server.disks} threshold={server.thresholds.diskPct} />
          <ChecksPanel
            serverCode={server.code}
            checks={server.checks}
            canManage={server.canManage}
            selectedId={check?.id ?? null}
            onSelect={(id) => {
              setSearch({ check: id ?? undefined });
              if (id)
                document.getElementById("server-charts")?.scrollIntoView?.({ block: "start" });
            }}
          />
          <SshAccessPanel server={server} />
          <ThresholdsPanel
            serverCode={server.code}
            thresholds={server.thresholds}
            canManage={server.canManage}
          />
          {server.canManage && <ServerSettings server={server} projectCode={projectCode} />}
          <SimulatePanel server={server} />
        </div>
      </div>
    </section>
  );
}

export function ServerDetail({
  projectCode,
  code,
}: {
  /** Il progetto da cui si apre; `null` dall'Amministrazione (area 9b). */
  projectCode: string | null;
  code: string;
}) {
  const { t } = useTranslation();
  const q = useServer(code);
  if (q.isError) {
    if (q.error instanceof Error && q.error.message === "not_found")
      return <NotFound projectCode={projectCode} />;
    return (
      <section className="p-8">
        <PageError message={t("servers.errors.detail")} onRetry={() => void q.refetch()} />
      </section>
    );
  }
  if (!q.data) return <DetailSkeleton />;
  const server = q.data;
  // Di un altro progetto: come uno che non esiste (R-G5). Un server orfano
  // (R-L7, nessun ambiente) si apre da ⌘K nel progetto di chi guarda.
  // Dall'Amministrazione il server è un oggetto d'istanza: nessun confronto.
  if (
    projectCode !== null &&
    server.environments.length > 0 &&
    !server.environments.some((e) => e.projectCode === projectCode)
  )
    return <NotFound projectCode={projectCode} />;
  return <Page server={server} projectCode={projectCode} />;
}
