import { Link } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useAutomationRuns,
  useAutomations,
  useAutomationSources,
  useDepartments,
  useMyAutomationApprovals,
  usePeople,
  useProjects,
  useSessionPersonId,
} from "../../data/queries";
import { can, useViewer } from "../../data/viewer";
import type { Automation, RunStatus } from "../../data/types";
import { problemsOf, type Names, type TemplatePart } from "./format";
import { AutomationStatusGlyph, RunStatusGlyph } from "./glyphs";

// I pezzi comuni delle pagine delle Automations: i nomi che le frasi citano,
// gli stati in parola con il loro glifo, la pagina R-G5 e i gettoni dei dati.

/** I nomi delle persone, dei progetti visibili, delle sorgenti e dei reparti. */
export function useNames(): Names {
  const { t } = useTranslation();
  const people = usePeople().data;
  const projects = useProjects().data;
  const sources = useAutomationSources().data;
  const departments = useDepartments().data;
  return useMemo(
    () => ({
      person: (id) =>
        id ? (people?.find((p) => p.id === id)?.name ?? t("automations.someone")) : "—",
      project: (id) => {
        const p = id ? projects?.find((x) => x.id === id) : undefined;
        return p ? { code: p.code, name: p.name } : null;
      },
      source: (id) => sources?.find((s) => s.id === id),
      department: (id) => departments?.find((d) => d.id === id)?.name ?? id,
    }),
    [people, projects, sources, departments, t],
  );
}

export const useMe = useSessionPersonId;

/** Il permesso per creare ciò che crea un passo: lo stesso che controllano `activate`/`publish`. */
const CREATE_PERMISSION = {
  createTask: "tickets.create",
  createMilestone: "tickets.edit",
  createRequest: "backlog.create",
} as const;

/**
 * Cosa può fare chi guarda, dai permessi calcolati: creare automazioni (in
 * almeno un progetto o d'istanza), le generali (d'istanza), le sorgenti.
 */
export function useAutomationPerms() {
  const { viewer } = useViewer();
  const instance = can(viewer, "automations.manage");
  return {
    instance,
    anywhere:
      instance ||
      Object.values(viewer.projectPermissions).some((p) =>
        (p as readonly string[]).includes("automations.manage"),
      ),
    inProject: (projectId: string) => can(viewer, "automations.manage", projectId),
    integrations: can(viewer, "integrations.manage"),
    createTasks: (projectId: string) => can(viewer, "tickets.create", projectId),
    /** Il permesso che serve per creare ciò che crea un passo (come `activate`/`publish`). */
    canCreate: (kind: "createTask" | "createMilestone" | "createRequest", projectId: string) =>
      can(viewer, CREATE_PERMISSION[kind], projectId),
  };
}

/**
 * «Needs attention» (shape [A 6]): le automazioni con problemi che posso
 * gestire, le esecuzioni fallite di ciò che posso gestire e quelle che
 * aspettano me. `waitingMe` accende il punto «ti aspetta».
 */
export function useAttention() {
  const automations = useAutomations();
  const runs = useAutomationRuns();
  const approvals = useMyAutomationApprovals();
  return useMemo(() => {
    const manage = new Set(
      (automations.data ?? []).filter((a) => a.permissions.manage).map((a) => a.id),
    );
    const mine = new Set((approvals.data ?? []).map((d) => d.runId));
    const automationIds = new Set(
      (automations.data ?? [])
        .filter((a) => a.permissions.manage && a.status !== "draft" && problemsOf(a).total > 0)
        .map((a) => a.id),
    );
    const runIds = new Set(
      (runs.data ?? [])
        .filter((r) => mine.has(r.id) || (r.status === "failed" && manage.has(r.automationId)))
        .map((r) => r.id),
    );
    return {
      automationIds,
      runIds,
      waitingMe: mine,
      count: automationIds.size + runIds.size,
      ready: automations.data !== undefined && runs.data !== undefined,
    };
  }, [automations.data, runs.data, approvals.data]);
}

/** Lo stato di un'automazione: glifo e parola (mai solo colore). */
export function AutomationStatusWord({ status }: { status: Automation["status"] }) {
  const { t } = useTranslation();
  return (
    <span
      data-automation-status={status}
      className="inline-flex items-center gap-1.5 text-sm text-ink-muted"
    >
      <AutomationStatusGlyph status={status} />
      <span className={status === "active" ? "text-ink" : ""}>
        {t(`automations.status.${status}`)}
      </span>
    </span>
  );
}

/**
 * Lo stato di un'esecuzione: in elenco la parola breve («Waiting»), intera
 * nel dettaglio e nei nomi accessibili (shape [A 28]).
 */
export function RunStatusWord({
  status,
  mine = false,
  short = false,
}: {
  status: RunStatus;
  mine?: boolean;
  short?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span
      data-run-status={status}
      className="inline-flex min-w-0 items-center gap-1.5 text-sm text-ink"
    >
      <RunStatusGlyph status={status} mine={mine} />
      <span className="min-w-0">
        {t(`automations.runStatus.${short ? "short" : "full"}.${status}`)}
      </span>
    </span>
  );
}

/** Un riferimento a un dato: gettone sottolineato a puntini, la chiave nel tooltip (shape [A 9]). */
export function TemplateText({ parts }: { parts: TemplatePart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        "text" in p ? (
          <span key={i}>{p.text}</span>
        ) : (
          <span
            key={i}
            data-token={p.ref}
            title={p.ref}
            className="underline decoration-ink-faint decoration-dotted underline-offset-[3px]"
          >
            {p.label}
          </span>
        ),
      )}
    </>
  );
}

/**
 * Inesistente o invisibile (R-G5): la stessa pagina nei due casi, per
 * un'automazione, un'esecuzione o la pagina delle sorgenti.
 */
export function NotVisible({ what }: { what: "automation" | "run" | "page" }) {
  const { t } = useTranslation();
  return (
    <section
      data-not-visible={what}
      className="page-header flex flex-col items-start gap-2 pb-8 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]"
    >
      <h1 className="text-2xl font-semibold text-ink">{t(`automations.notVisible.${what}`)}</h1>
      <p className="text-md text-ink-muted">{t("automations.notVisible.body")}</p>
      <Link to="/automations" className="text-md text-ink underline underline-offset-4">
        {t("automations.notVisible.back")}
      </Link>
    </section>
  );
}

/** Il riquadro tratteggiato «Prototype only» (shape [A 15], sources [A 4]). */
export function PrototypeBox({ children, label }: { children: ReactNode; label?: string }) {
  const { t } = useTranslation();
  return (
    <section
      data-prototype-only
      aria-label={label ?? t("automations.prototype.only")}
      className="flex flex-col gap-2 rounded-lg border border-dashed border-rule-strong px-4 py-3"
    >
      <p aria-hidden="true" className="heading-group">
        {t("automations.prototype.only")}
      </p>
      {children}
    </section>
  );
}

/** Link testuale delle pagine: inchiostro, sottolineato al passaggio. */
export const textLink =
  "rounded-sm text-ink underline-offset-4 transition-colors duration-[var(--duration-fast)] ease-out hover:underline";

/** Il codice (tabellare, 600) di un'automazione o di un'esecuzione. */
export const codeClass = "num text-xs font-semibold tracking-[0.02em] text-ink";
