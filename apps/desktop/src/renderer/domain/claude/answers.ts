import type { CitationRef, ProposedAction, ScriptStep, Task, Utterance } from "../../data/types";
import type { IntentContext, T } from "./context";

// Come si dice una risposta: i passi dello stream (azioni di lettura, testo,
// citazioni, proposta) e i pezzi di testo che tornano in più intenti. I
// testi stanno nei file di lingua (`claude.answers.*`): qui solo la forma.

/** Un'azione di lettura già fatta: la riga compatta «Read your week · 4 found». */
export interface ReadAction {
  tool: string;
  label: string;
  labelText?: Utterance;
  result?: string;
  resultText?: Utterance;
}

type Params = Record<string, string | number>;

/** Una frase come chiave e parametri (si rilegge nella lingua di chi guarda). */
export const utterance = (key: string, params?: Params): Utterance =>
  params ? { key, params } : { key };

/** La frase nella lingua di adesso; senza frase, il testo salvato. */
export const spoken = (t: T, text: Utterance | undefined, fallback: string): string =>
  text ? t(text.key, text.params) : fallback;

/** L'etichetta di un'azione: la resa di adesso e la frase. */
export const labelled = (t: T, key: string, params?: Params) => ({
  label: t(key, params),
  labelText: utterance(key, params),
});

/** Il risultato di un'azione: la resa di adesso e la frase. */
export const resulted = (t: T, key: string, params?: Params) => ({
  result: t(key, params),
  resultText: utterance(key, params),
});

/** Il riassunto di una proposta: la resa di adesso e la frase. */
export const summarized = (t: T, key: string, params?: Params) => ({
  summary: t(key, params),
  summaryText: utterance(key, params),
});

export interface Answer {
  actions: ReadAction[];
  /** Il messaggio di Claude, in markdown. */
  text: string;
  refs?: CitationRef[];
  /** Le modifiche proposte: mai eseguite qui, solo una scheda da confermare. */
  proposal?: ProposedAction[];
  /** Una domanda a chi chiama (solo con `ctx.asks`): la risposta continua il lavoro. */
  ask?: {
    text: string;
    options: { label: string; consequence?: string; recommended?: boolean }[];
  };
}

/**
 * I passi di una risposta: consegna del messaggio, Claude al lavoro, le
 * letture, il testo, le citazioni, la proposta (aperta, di chi conversa) e
 * di nuovo in attesa. Nessun passo scrive dati di Stubwise.
 */
export function toSteps(answer: Answer, ctx: IntentContext, text: string): ScriptStep[] {
  const steps: ScriptStep[] = [{ step: "deliver" }, { step: "state", state: "working" }];
  for (const a of answer.actions) {
    const step: Extract<ScriptStep, { step: "action" }> = {
      step: "action",
      tool: a.tool,
      label: a.label,
    };
    if (a.labelText) step.labelText = a.labelText;
    if (a.result !== undefined) step.result = a.result;
    if (a.resultText) step.resultText = a.resultText;
    steps.push(step);
  }
  // Con una domanda il testo può mancare: la domanda dice già tutto.
  if (answer.text) steps.push({ step: "say", text: answer.text });
  const refs = dedupeRefs(answer.refs ?? []);
  if (refs.length > 0) steps.push({ step: "event", event: { type: "citation", refs } });
  if (answer.ask) {
    steps.push({
      step: "event",
      event: {
        type: "question",
        questionId: proposalId(ctx, `ask|${text}`).replace("prop-", "q-"),
        text: answer.ask.text,
        options: answer.ask.options,
        answer: null,
      },
    });
  }
  if (answer.proposal && answer.proposal.length > 0) {
    steps.push({
      step: "event",
      event: {
        type: "proposal",
        proposalId: proposalId(ctx, text),
        requesterId: ctx.personId,
        actions: answer.proposal,
        status: "open",
      },
    });
  }
  steps.push({ step: "state", state: "idle" });
  return steps;
}

function dedupeRefs(refs: CitationRef[]): CitationRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Id deterministico della proposta: seme del chiamante + chi + testo (FNV-1a). */
function proposalId(ctx: IntentContext, text: string): string {
  let hash = 2166136261;
  for (const ch of `${ctx.seed ?? ""}|${ctx.personId}|${text}`) {
    hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  }
  return `prop-${hash.toString(36)}`;
}

/** Un oggetto come lo dice il Catalogo: codice + nome. */
export const named = (o: { code: string; title: string }) => `${o.code} ${o.title}`;

/** «W44» di «2026-W44». */
export const shortWeek = (week: string) => week.slice(week.indexOf("W"));

/** Una data ISO detta nella lingua di `t` («Oct 23», «23 ott»). */
export const sayDate = (t: T, iso: string) =>
  t("claude.answers.date", { date: new Date(`${iso.slice(0, 10)}T00:00:00Z`) });

/** Un elenco puntato, con «…e altri N» oltre il tetto. */
export function bulleted(t: T, lines: string[], max = 5): string {
  const shown = lines.slice(0, max).map((l) => `- ${l}`);
  if (lines.length > max)
    shown.push(`- ${t("claude.answers.more", { count: lines.length - max })}`);
  return shown.join("\n");
}

/** I dettagli di una task in una riga di catalogo: «Marco Bellini · W44 · M». */
export function taskMeta(task: Task, names: Map<string, string>): string {
  return [
    task.assigneeId ? names.get(task.assigneeId) : null,
    task.plannedWeek ? shortWeek(task.plannedWeek) : null,
    task.size,
  ]
    .filter(Boolean)
    .join(" · ");
}
