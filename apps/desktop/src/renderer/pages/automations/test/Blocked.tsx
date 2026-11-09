import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { stepAt } from "../../../domain/automations/fields";
import type { FlowIssue } from "../../../domain/automations/validate";
import { useAutomationSources } from "../../../data/queries";
import { CriticalGlyph } from "../glyphs";
import { useNames } from "../shared";
import { startProblems, stepProblems } from "../builder/issues";
import { flowPathOf, useTest } from "./context";

/** La bozza ha problemi: nessuna prova parte; ogni riga porta al passo nel costruttore ([A 5]). */
export function Blocked({ issues }: { issues: FlowIssue[] }) {
  const { t } = useTranslation();
  const names = useNames();
  const ctx = useTestFlowWords();
  // I problemi in parole, come nel costruttore: per passo (tutti i suoi campi), senza doppioni.
  const lines: { text: string; step: string | null }[] = [];
  const seen = new Set<string>();
  const push = (text: string, step: string | null) => {
    if (seen.has(text)) return;
    seen.add(text);
    lines.push({ text, step });
  };
  const byPath = new Map<string, FlowIssue[]>();
  for (const i of issues) byPath.set(i.path, [...(byPath.get(i.path) ?? []), i]);
  for (const [path, group] of byPath) {
    if (path === "trigger" || path === "") {
      for (const problem of startProblems(group, ctx.flow, names, t))
        push(
          t("automations.test.blocked.start", { problem }),
          path === "trigger" ? "trigger" : null,
        );
      continue;
    }
    const fp = flowPathOf(path);
    const s = stepAt(ctx.flow.steps, fp);
    const n = ctx.numbers.get(fp) ?? 0;
    const texts = s
      ? stepProblems(group, ctx.flow, fp, s, ctx.problemCtx, t).map((p) => p.text)
      : [];
    if (texts.length === 0) texts.push(t(`automations.builder.short.${group[0]!.code}`));
    for (const problem of texts)
      push(t("automations.test.blocked.step", { n, problem }), s?.id ?? null);
  }
  return (
    <section
      data-test-blocked
      aria-labelledby="test-blocked"
      className="flex max-w-[760px] flex-col gap-3 px-8 pt-6 pb-24"
    >
      <h2 id="test-blocked" className="flex items-center gap-2 text-xl font-semibold text-ink">
        <CriticalGlyph />
        {t("automations.test.blocked.title")}
      </h2>
      <p className="text-md text-ink-muted">{t("automations.test.blocked.body")}</p>
      <ul className="flex flex-col">
        {lines.map((l, k) => (
          <li key={k}>
            <Link
              to="/automations/$code/edit"
              params={{ code: ctx.automation.code }}
              search={(l.step ? { step: l.step } : {}) as never}
              data-blocked-problem
              className="flex min-h-9 items-center gap-2 rounded-md px-2 text-md text-ink hover:bg-ink/6"
            >
              <CriticalGlyph />
              {l.text}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Ciò che serve a dire i problemi in parole, dal contesto della prova. */
function useTestFlowWords() {
  const ctx = useTest();
  const sources = useAutomationSources().data ?? [];
  return {
    ...ctx,
    problemCtx: {
      general: ctx.automation.projectId === null,
      names: ctx.names,
      ownerId: ctx.automation.ownerId,
      projectCode: ctx.names.project(ctx.automation.projectId)?.code ?? null,
      sources,
      labels: ctx.labels,
    },
  };
}
