import type {
  CapabilityId,
  CitationRef,
  FieldRef,
  PageAction,
  ProductWeekAnswer,
  ProposalNote,
  ProposedAction,
  ScriptStep,
  Task,
  Utterance,
} from "../../data/types";
import { shortWeekIn } from "../weeks";
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

/** Una data ISO («2026-08-04», con o senza ora). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

/**
 * I parametri di una frase pronti per `t`: una data ISO in `date` diventa
 * una `Date` del suo giorno (UTC), perché il formattatore la dica nella
 * lingua di chi guarda («Aug 4» / «4 ago») invece di stampare la stringa
 * (area 10b, il `why` delle schede).
 */
function paramsOf(params: Utterance["params"]): Record<string, unknown> | undefined {
  const date = params?.date;
  if (typeof date !== "string" || !ISO_DATE.test(date)) return params;
  return { ...params, date: new Date(`${date.slice(0, 10)}T00:00:00Z`) };
}

/** La frase nella lingua di adesso; senza frase, il testo salvato. */
export const spoken = (t: T, text: Utterance | undefined, fallback: string): string =>
  text ? t(text.key, paramsOf(text.params)) : fallback;

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
  /**
   * Area 10a: le azioni di classe A (`ctx.classify`), da eseguire subito.
   * Nemmeno queste si eseguono qui: diventano un evento `executed`
   * `pending`, che esegue (o trasforma in scheda) `freeTurn`.
   */
  execute?: ProposedAction[];
  /**
   * Area 10a, la riga D (Claude non lo fa): il posto vero, scritto in fondo
   * alla frase come link markdown, con l'etichetta che finisce con «→».
   * `route` `null`: la frase da sola (il deploy). Nessun tipo d'evento nuovo:
   * è testo di Claude, nel passo `say`.
   */
  place?: { route: string | null; labelKey: string; labelParams?: Params };
  /** Una domanda a chi chiama (solo con `ctx.asks`): la risposta continua il lavoro. */
  ask?: {
    text: string;
    options: {
      label: string;
      consequence?: string;
      recommended?: boolean;
      /** L'opzione è un reparto (S1): la scheda ne disegna la striscia. */
      departmentId?: string;
    }[];
    /**
     * Area 10b, la richiesta da riprendere dopo la risposta (solo nella
     * libera, `ctx.classify`). Assente: il messaggio a cui si risponde.
     */
    resume?: string;
  };
  /**
   * Area 10b (S1): la prova della bozza che `execute` crea, sugli esempi
   * chiesti. Solo nella libera (`ctx.classify`, P11) e solo dopo un'azione
   * da eseguire: diventa un evento `trial` `pending`, che risolve `freeTurn`.
   */
  trial?: { wants: ("passes" | "fails")[] };
  /**
   * Area 10b (S2): le righe sotto la risposta che non sono un fatto della
   * prima riga — al più una «Hypothesis» (una deduzione, mai nel testo) e
   * un «Details» (come è contato). Diventano eventi `aside` dopo il testo.
   */
  aside?: { kind: "hypothesis" | "details"; text: string }[];
  /** Area 10b (S0): cosa sa fare il prototipo, un evento `capabilities` dopo il testo. */
  capabilities?: CapabilityId[];
  /**
   * Area 10b (S4): le righe sotto la scheda (non gestibili, occupati),
   * scritte sulla `proposal`. Senza scheda non c'è dove scriverle: le dice
   * il testo (ruling del controller, Q1).
   */
  notes?: ProposalNote[];
  /** Area 10b (S5): la scheda nasce bloccata (`canGrantRole` `escalation`), scritta sulla `proposal`. */
  blocked?: { kind: "escalation"; roleId: string };
  /**
   * Area 10b (S6, S6b, D1): la bozza per un campo. Non scrive dati: diventa
   * un evento `draft` `pending`, che il riquadro mette nel campo (Task 10).
   * Solo nella libera (`ctx.classify`, P11): nella Chat nessuno la metterebbe.
   */
  draft?: { field: FieldRef; text: string; sources?: string[] };
  /**
   * Area 10b (Task 9): un'azione della pagina (lingua, tema, filtro), classe
   * A. Non scrive dati: diventa un evento `pageAction` `pending`, che il
   * riquadro di chi chiede esegue. Solo nella libera (`ctx.classify`, P11).
   */
  page?: PageAction;
  /**
   * 11b (fix round 1 del Task 8): «cosa è cambiato questa settimana» come
   * dato sul messaggio di Claude; `text` è solo la riserva senza nomi né
   * fonti, e chi legge riceve il testo ricomposto per lui.
   */
  productWeek?: ProductWeekAnswer;
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
  // La bozza prima della frase: «scrivi e manda l'email» dà la riga `draft`,
  // poi la riga D `send` (area 10b, D1).
  if (answer.draft && ctx.classify) {
    const { field, text: body, sources } = answer.draft;
    steps.push({
      step: "event",
      event: {
        type: "draft",
        field,
        text: body,
        ...(sources && sources.length > 0 ? { sources } : {}),
        status: "pending",
      },
    });
  }
  // Con una domanda il testo può mancare: la domanda dice già tutto.
  const said = answer.place?.route
    ? `${answer.text} [${ctx.t(answer.place.labelKey, answer.place.labelParams)}](${answer.place.route})`
    : answer.text;
  if (said) {
    steps.push({
      step: "say",
      text: said,
      ...(answer.productWeek ? { productWeek: answer.productWeek } : {}),
    });
  }
  // L'azione della pagina dopo la sua frase (se c'è): la esegue il riquadro (P22).
  if (answer.page && ctx.classify) {
    steps.push({
      step: "event",
      event: { type: "pageAction", action: answer.page, status: "pending" },
    });
  }
  // Area 10b: l'elenco della risposta onesta, poi «Hypothesis» e «Details»
  // (nell'ordine dello shape), sotto il testo e mai dentro.
  if (answer.capabilities && answer.capabilities.length > 0) {
    steps.push({ step: "event", event: { type: "capabilities", items: answer.capabilities } });
  }
  for (const a of answer.aside ?? []) {
    steps.push({ step: "event", event: { type: "aside", kind: a.kind, text: a.text } });
  }
  // Le azioni A subito dopo la loro frase («Fatto…»): se all'esecuzione la
  // classe è salita, `freeTurn` cambia quella frase e l'evento in una scheda.
  if (answer.execute && answer.execute.length > 0) {
    steps.push({
      step: "event",
      event: { type: "executed", groupId: "", actions: answer.execute, status: "pending" },
    });
    // La prova subito dopo la creazione (area 10b): nella Chat nessuno la
    // risolverebbe, quindi non c'è (P11).
    if (answer.trial && ctx.classify) {
      steps.push({
        step: "event",
        event: { type: "trial", status: "pending", wants: answer.trial.wants },
      });
    }
  }
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
        // Nella libera la risposta riprende la richiesta (area 10b); nella
        // Chat la riprende la sua chiamata, e la domanda resta com'era.
        ...(ctx.classify ? { resume: answer.ask.resume ?? text } : {}),
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
        ...(answer.notes && answer.notes.length > 0 ? { notes: answer.notes } : {}),
        ...(answer.blocked ? { blocked: answer.blocked } : {}),
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

/** «W44» / «S44» di «2026-W44», nella lingua di `t` (una convenzione sola, `shortWeekIn`). */
export const shortWeek = (t: T, week: string) => shortWeekIn(t, week);

/** Una data ISO detta nella lingua di `t` («Oct 23», «23 ott»). */
export const sayDate = (t: T, iso: string) =>
  t("claude.answers.date", { date: new Date(`${iso.slice(0, 10)}T00:00:00Z`) });

/**
 * Un elenco puntato, con «…e altri N» oltre il tetto. Con `more` (area 10b,
 * le risposte corte) la coda è una riga a sé sotto l'elenco, «and N more ·
 * open the list», col link alla pagina che li mostra tutti.
 */
export function bulleted(t: T, lines: string[], max = 5, more?: { route: string }): string {
  const shown = lines.slice(0, max).map((l) => `- ${l}`);
  const rest = lines.length - max;
  if (rest <= 0) return shown.join("\n");
  if (!more) return [...shown, `- ${t("claude.answers.more", { count: rest })}`].join("\n");
  const tail = `${t("claude.answers.moreList", { count: rest })} · [${t("claude.answers.openList")}](${more.route})`;
  return `${shown.join("\n")}\n\n${tail}`;
}

/** I dettagli di una task in una riga di catalogo: «Marco Bellini · W44 · M». */
export function taskMeta(t: T, task: Task, names: Map<string, string>): string {
  return [
    task.assigneeId ? names.get(task.assigneeId) : null,
    task.plannedWeek ? shortWeek(t, task.plannedWeek) : null,
    task.size,
  ]
    .filter(Boolean)
    .join(" · ");
}
