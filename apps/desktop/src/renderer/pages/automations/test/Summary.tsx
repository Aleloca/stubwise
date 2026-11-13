import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { stepAt } from "@stubwise/shared";
import type { SimulationView } from "../../../data/types";
import { primaryButton } from "../../tasks/controls";
import { conditionWords, reasonWords } from "../format";
import { CriticalGlyph } from "../glyphs";
import { flowPathOf, useTest } from "./context";
import { MarkGlyph } from "./TestFlow";
import { soFarParts } from "./words";

// Il riepilogo della prova (shape automation-test §3 e §5, «Fine»): in fondo
// all'elenco, «So far: would create …» con i conteggi che crescono; a prova
// finita, nel pannello (`EndSummary`): finita bene la sezione «If this were
// real» a gruppi; finita male, dove si è fermata e perché, con «Edit step
// N». Il titolo prende il fuoco (`tabIndex -1`). Mai un numero animato.

const group = "flex flex-col gap-1.5";
const rowText = "flex min-w-0 items-baseline gap-2 text-sm text-ink";

/** In fondo all'elenco, mentre la prova va: «So far». */
export function Summary() {
  const { t } = useTranslation();
  const ctx = useTest();
  const sim = ctx.sim;
  if (!sim || ["done", "failed", "cancelled"].includes(sim.status)) return null;
  const parts = soFarParts(sim, t);
  return (
    <p data-so-far className="border-t border-rule pt-3 text-sm text-ink-muted">
      {parts.length > 0
        ? t("automations.test.summary.soFar", { list: parts.join(" · ") })
        : t("automations.test.summary.soFarNothing")}
    </p>
  );
}

/** Nel pannello, a prova finita: «If this were real», o dove si è fermata. */
export function EndSummary() {
  const sim = useTest().sim;
  if (!sim) return null;
  if (sim.filteredOut) return <FilteredOutSummary sim={sim} />;
  if (sim.status === "done") return <FinalSummary sim={sim} />;
  if (sim.status === "failed" || sim.status === "cancelled") return <StoppedSummary sim={sim} />;
  return null;
}

/**
 * D3 (area 10b): il filtro dell'inizio esclude l'esempio, la vera non
 * partirebbe. Una riga per confronto col valore dell'esempio, segno + parola:
 * l'esito lo calcola il livello dati (`filterChecks`), qui si traduce e basta.
 * [AU 10]: niente «Turn on», «Change example» è il primario — anche qui, perché
 * a 1024 il pannello sovrapposto copre la testata.
 */
function FilteredOutSummary({ sim }: { sim: SimulationView }) {
  const { t } = useTranslation();
  const ctx = useTest();
  const checks = sim.filterChecks ?? [];
  const valueWords = (key: string, v: unknown) => {
    if (v === true) return t("automations.condition.true");
    if (v === false) return t("automations.condition.false");
    if (v === undefined || v === null || v === "") return t("automations.test.filteredOut.empty");
    if (key === "richiesta.urgenza" && (v === "low" || v === "medium" || v === "high"))
      return t(`automations.builder.condition.urgency.${v}`);
    return String(v);
  };
  return (
    <section
      data-test-filtered-out
      aria-labelledby="test-filtered-out"
      className="flex flex-col gap-3"
    >
      <h2
        id="test-filtered-out"
        tabIndex={-1}
        data-summary-heading
        className="flex items-start gap-2 text-lg font-semibold text-ink outline-none"
      >
        <span className="pt-1">
          <MarkGlyph mark="filteredOut" />
        </span>
        {t("automations.test.filteredOut.title")}
      </h2>
      {checks.length > 0 && (
        <ul className="flex flex-col gap-1">
          {checks.map(({ condition: leaf, value, matches: ok }, i) => {
            const key = leaf.left && "ref" in leaf.left ? leaf.left.ref : "";
            return (
              <li key={i} data-filter-row={ok ? "matches" : "doesnt"} className={rowText}>
                <span className="shrink-0 pt-0.5">
                  {ok ? <MarkGlyph mark="done" /> : <MarkGlyph mark="filteredOut" />}
                </span>
                <span className="min-w-0">
                  {t("automations.test.filteredOut.condition", {
                    condition: conditionWords(leaf, ctx.labels, t),
                    value: valueWords(key, value),
                  })}
                  {" · "}
                  <span className="font-medium">
                    {ok
                      ? t("automations.test.filteredOut.matches")
                      : t("automations.test.filteredOut.doesntMatch")}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p data-nothing className="max-w-[68ch] text-md text-ink">
        {t("automations.test.filteredOut.nothing")}
      </p>
      <p className="max-w-[68ch] text-sm text-ink-muted">
        {t("automations.test.filteredOut.hint")}
      </p>
      {ctx.changeExample && (
        <button
          type="button"
          data-summary-change-example
          className={`${primaryButton} self-start disabled:opacity-40`}
          disabled={ctx.busy}
          onClick={ctx.changeExample}
        >
          {t("automations.test.meta.change")}
        </button>
      )}
    </section>
  );
}

function StoppedSummary({ sim }: { sim: SimulationView }) {
  const { t } = useTranslation();
  const ctx = useTest();
  const path = sim.cursor ?? sim.log.at(-1)?.path ?? "";
  const step = stepAt(ctx.flow.steps, flowPathOf(path));
  const n = ctx.numbers.get(flowPathOf(path)) ?? 0;
  const reason = reasonWords([...sim.log].reverse().find((e) => e.path === path && e.why)?.why, t, {
    would: true,
  });
  const rejected = sim.status === "cancelled";
  return (
    <section data-test-stopped aria-labelledby="test-stopped" className="flex flex-col gap-2">
      <h2
        id="test-stopped"
        tabIndex={-1}
        data-summary-heading
        className="flex items-center gap-2 text-lg font-semibold text-ink outline-none"
      >
        <CriticalGlyph />
        {rejected
          ? t("automations.test.summary.rejected", { n })
          : t("automations.test.summary.stoppedAt", { n })}
      </h2>
      {!rejected && reason && <p className="max-w-[68ch] text-md text-ink">{reason}</p>}
      {!rejected && step && (
        <Link
          to="/automations/$code/edit"
          params={{ code: ctx.automation.code }}
          search={{ step: step.id } as never}
          data-edit-step
          className="self-start text-md text-ink underline underline-offset-4"
        >
          {t("automations.test.summary.editStep", { n })}
        </Link>
      )}
    </section>
  );
}

function FinalSummary({ sim }: { sim: SimulationView }) {
  const { t } = useTranslation();
  const ctx = useTest();
  const p = sim.preview;
  const nothing =
    p.tasks.length +
      p.milestones.length +
      p.requests.length +
      p.emails.length +
      p.notifications.length +
      p.starts.length ===
    0;
  const approvals = sim.log.filter((e) => e.outcome === "approved");
  const waits = sim.log.filter((e) => e.kind === "wait" && e.outcome !== "waiting");
  const waitDays = waits.reduce((sum, e) => {
    const w = e.input as { days?: number; maxDays?: number };
    return sum + (w.days ?? w.maxDays ?? 0);
  }, 0);
  const project = (x: { project: { code: string } }) =>
    x.project.code || t("automations.test.preview.hiddenProject");
  return (
    <section data-test-final aria-labelledby="test-final" className="flex flex-col gap-4">
      <h2
        id="test-final"
        tabIndex={-1}
        data-summary-heading
        className="text-xl font-semibold text-ink outline-none"
      >
        {t("automations.test.summary.final")}
      </h2>
      {nothing ? (
        <p data-nothing className="text-md text-ink">
          {t("automations.test.summary.nothing")}
        </p>
      ) : (
        <>
          {(p.milestones.length > 0 || p.tasks.length > 0 || p.requests.length > 0) && (
            <div className={group}>
              <h3 className="heading-group">{t("automations.test.summary.wouldCreate")}</h3>
              <ul className="flex flex-col gap-1">
                {p.milestones.map((m) => (
                  <li key={m.path} className={rowText}>
                    <span className="w-28 shrink-0 text-ink-faint">
                      {t("automations.test.preview.newMilestone")}
                    </span>
                    <span className="min-w-0 truncate font-medium">{m.name}</span>
                    <span className="shrink-0 text-ink-muted">{project(m)}</span>
                  </li>
                ))}
                {p.tasks.map((x) => (
                  <li key={x.path} className={rowText}>
                    <span className="w-28 shrink-0 text-ink-faint">
                      {t("automations.test.preview.newTask")}
                    </span>
                    <span className="min-w-0 truncate">{x.title}</span>
                    <span className="shrink-0 text-ink-muted">
                      {project(x)} ·{" "}
                      {x.assigneeId
                        ? ctx.names.person(x.assigneeId)
                        : x.departmentId
                          ? ctx.names.department(x.departmentId)
                          : t("automations.test.preview.byNone")}
                    </span>
                  </li>
                ))}
                {p.requests.map((x) => (
                  <li key={x.path} className={rowText}>
                    <span className="w-28 shrink-0 text-ink-faint">
                      {t("automations.test.preview.newRequest")}
                    </span>
                    <span className="min-w-0 truncate">{x.title}</span>
                    <span className="shrink-0 text-ink-muted">{project(x)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.emails.length > 0 && (
            <div className={group}>
              <h3 className="heading-group">{t("automations.test.summary.wouldSend")}</h3>
              <ul className="flex flex-col gap-1">
                {p.emails.map((e) => (
                  <li key={e.path}>
                    <button
                      type="button"
                      onClick={() => ctx.select(e.path)}
                      className={`${rowText} w-full rounded-md text-left hover:bg-ink/4`}
                    >
                      <span className="min-w-0 truncate font-medium">{e.subject}</span>
                      <span className="shrink-0 text-ink-muted">
                        {t("automations.test.summary.to", { to: e.to })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.notifications.length > 0 && (
            <div className={group}>
              <h3 className="heading-group">{t("automations.test.summary.wouldNotify")}</h3>
              <ul className="flex flex-col gap-1">
                {p.notifications.map((x) => (
                  // Un reparto avvisa più persone allo stesso percorso.
                  <li key={`${x.path}:${x.personId}`} className={rowText}>
                    <span className="shrink-0 font-medium">{ctx.names.person(x.personId)}</span>
                    <span className="min-w-0 truncate text-ink-muted">“{x.text}”</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.starts.length > 0 && (
            <div className={group}>
              <h3 className="heading-group">{t("automations.test.summary.wouldStart")}</h3>
              <ul className="flex flex-col gap-1">
                {p.starts.map((x) => (
                  <li key={x.path} className={rowText}>
                    {x.code ? `${x.code} ${x.name}` : t("automations.test.row.startAny")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {(approvals.length > 0 || waits.length > 0) && (
        <div className={group}>
          <h3 className="heading-group">{t("automations.test.summary.stops")}</h3>
          <ul className="flex flex-col gap-1 text-sm text-ink">
            {approvals.map((e, i) => (
              <li key={`a${i}`}>
                {t("automations.test.summary.stopApproval", {
                  name: realApproverName(sim, e.path, ctx, t),
                })}
              </li>
            ))}
            {waits.length > 0 && (
              <li>{t("automations.test.summary.waiting", { count: waitDays })}</li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Chi approverebbe davvero un passo già approvato nella prova (dal passo, mai chi prova). */
function realApproverName(
  sim: SimulationView,
  path: string,
  ctx: ReturnType<typeof useTest>,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  const step = stepAt(ctx.flow.steps, flowPathOf(path));
  if (!step || !("approval" in step) || step.approval.mode !== "ask") return "";
  const who = step.approval.who;
  if ("owner" in who) return ctx.names.person(sim.ownerId);
  if ("personId" in who) return ctx.names.person(who.personId);
  return t(`automations.roles.${who.projectRole}`, { defaultValue: who.projectRole });
}
