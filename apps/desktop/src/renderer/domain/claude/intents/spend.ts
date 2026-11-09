import type { SpendView } from "../../../data/types";
import { bulleted, labelled, sayDate, type Answer } from "../answers";
import type { IntentContext, T } from "../context";
import { findPerson, isHowToQuestion, normalize } from "../parse";

// S3 (area 10b, Task 6): «quanto abbiamo speso in AI questo mese?». La spesa
// come chi chiede la vede in Usage (`spendThisMonth`): d'istanza con
// `usage.view`, la somma dei suoi progetti con `project.usage.view`, niente
// senza. Nella vista dei progetti nessun numero è il totale d'istanza e
// nessuna frase dice «di più» o «in tutto». I consumi per persona non
// esistono: lo si dice, senza stimarli.

/** La scheda Usage dell'Amministrazione → AI. */
export const USAGE_ROUTE = "#/admin/ai?tab=usage";

const SPEND_WORD =
  /\b(spent|spend|spends|spending|speso|spesa|spese|spende|spendiamo|spendono|spendo|consumi|consumato|usage)\b/;
const ABOUT_MONEY = /\b(how much|quanto|quanta|quanti|ai|budget|this month|questo mese|del mese)\b/;
const PER_PERSON =
  /\b(per person|each person|by person|per persona|ogni persona|a testa|who spends|chi spende)\b/;

/** «how much have we spent on AI this month?», «quanto spende Roberta?». */
export function isSpendQuestion(text: string): boolean {
  // «Come si imposta il budget dei consumi?» è una domanda per `howto` (ruling T6 I1).
  if (isHowToQuestion(text)) return false;
  const plain = normalize(text);
  return SPEND_WORD.test(plain) && (ABOUT_MONEY.test(plain) || PER_PERSON.test(plain));
}

export async function spend(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t } = ctx;
  // Il dato che manca: la spesa di una persona. Nessuna cifra, nessuna stima.
  const person = findPerson(text, await read.listPeople(), ctx.personId);
  if (person || PER_PERSON.test(normalize(text))) {
    return { actions: [], text: t("claude.answers.spend.perPerson") };
  }
  const view = await read.spendThisMonth();
  const actions = [{ tool: "get_usage", ...labelled(t, "claude.answers.actions.readUsage") }];
  switch (view.scope) {
    case "none":
      return {
        actions,
        text: `${t("claude.answers.spend.none")} · [${t("claude.answers.spend.who")}](who:seeUsage)`,
      };
    case "instance":
      return { actions, ...instance(t, view) };
    case "projects":
      return { actions, ...projects(t, view) };
  }
}

/** «$410.05»: lo speso con i centesimi, un budget intero senza (le regole di `i18n/money.ts`). */
const money = (t: T, amount: number) =>
  t(Number.isInteger(amount) ? "claude.answers.spend.usdWhole" : "claude.answers.spend.usd", {
    amount,
  });

function instance(t: T, view: Extract<SpendView, { scope: "instance" }>): Omit<Answer, "actions"> {
  const first =
    view.budgetUsd === null
      ? t("claude.answers.spend.instanceNoBudget", { total: money(t, view.totalUsd) })
      : t("claude.answers.spend.instance", {
          total: money(t, view.totalUsd),
          budget: money(t, view.budgetUsd),
        });
  const lines = view.top.map((r) =>
    r.code === null
      ? t("claude.answers.spend.otherLine", { usd: money(t, r.usd) })
      : t("claude.answers.spend.line", { code: r.code, usd: money(t, r.usd) }),
  );
  const parts = [first];
  if (lines.length > 0) {
    parts.push("", `**${t("claude.answers.spend.top")}**`, "", bulleted(t, lines, 3));
  }
  parts.push("", `[${t("claude.answers.spend.openUsage")}](${USAGE_ROUTE})`);
  return {
    text: parts.join("\n"),
    aside: [{ kind: "details", text: details(t, view.asOf) }],
    refs: view.top.flatMap((r) =>
      r.projectId ? [{ kind: "project" as const, id: r.projectId }] : [],
    ),
  };
}

function projects(t: T, view: Extract<SpendView, { scope: "projects" }>): Omit<Answer, "actions"> {
  const spent = view.projects.filter((p) => p.usd > 0);
  const parts = [t("claude.answers.spend.projects", { total: money(t, view.totalUsd) })];
  if (spent.length > 0) {
    parts.push(
      "",
      bulleted(
        t,
        spent.map((p) => t("claude.answers.spend.line", { code: p.code, usd: money(t, p.usd) })),
        5,
      ),
    );
  }
  parts.push(
    "",
    `${t("claude.answers.spend.totalVisibleTo")} · [${t("claude.answers.spend.who")}](who:seeUsage)`,
  );
  return {
    text: parts.join("\n"),
    aside: [{ kind: "details", text: details(t, view.asOf) }],
    refs: spent.slice(0, 5).map((p) => ({ kind: "project" as const, id: p.projectId })),
  };
}

/** «From Nov 1 to Nov 2, 10:41. The same totals as Usage.» */
function details(t: T, asOf: string): string {
  return t("claude.answers.spend.details", {
    from: sayDate(t, `${asOf.slice(0, 7)}-01`),
    to: sayDate(t, asOf),
    at: new Date(asOf),
  });
}
