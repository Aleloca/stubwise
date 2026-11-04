import type { FilterCriteria, PageAction, ProposedAction } from "../../../data/types";
import { parseCriteria } from "../../filters";
import { summarized, type Answer } from "../answers";
import type { IntentContext } from "../context";
import {
  QUESTION,
  STATUS,
  TODAY,
  findPerson,
  findProject,
  findTitle,
  isHowToQuestion,
  normalize,
  stripCourtesy,
} from "../parse";
import { byClass } from "./change";

// Le azioni della pagina (area 10b, Task 9): la lingua, il tema, il filtro
// della pagina sotto, e il filtro salvato personale. Le prime tre non sono
// scritture dei dati: diventano un evento `pageAction` `pending` che il
// riquadro di chi chiede esegue una volta (`usePageEventRunner`). Sono
// sempre classe A — toccano solo chi chiede e si rimettono a posto — quindi
// nessuna scheda. Il filtro salvato invece è una scrittura: `saveFilter` del
// catalogo, privato, con i criteri dell'ultimo filtro FATTO nella
// conversazione (P21). Nella Chat nessuno eseguirebbe niente: una riga
// rimanda al riquadro (P11). Una domanda «come si fa» resta a `howto` (il
// controllo unico, ruling T6 I1).

const K = "claude.answers.page";

/** Il verbo che cambia qualcosa della pagina, in testa (imperativo). */
const SWITCH =
  /^(switch|change|set|use|put|turn|go back|passa|passiamo|metti|mettimi|cambia|imposta|usa|porta|torna)\b/;
/** Lo stesso all'infinito, dopo una cortesia («Puoi passare al tema scuro?»). */
const SWITCH_INF =
  /^(switch|change|set|use|put|turn|passare|mettere|mettermi|cambiare|impostare|usare|portare|tornare)\b/;
/** I verbi con cui la lingua basta da sola: «switch to Italian», «passa all'italiano». */
const SWITCH_TO = /^(switch|go back|passa|passiamo|passare|torna|tornare)\b/;

const DARK = /\b(dark (theme|mode)|tema scuro|modalita scura)\b/;
const LIGHT = /\b(light (theme|mode)|tema chiaro|modalita chiara)\b/;
const SYSTEM = /\b(system (theme|mode)|tema (di|del) sistema|come il sistema)\b/;
/** Il tema da solo, come comando: «dark theme», «Dark mode, please», «tema scuro». */
const BARE_THEME =
  /^((the )?(dark|light|system) (theme|mode)|(il )?tema (scuro|chiaro|di sistema|del sistema)|modalita (scura|chiara))$/;
/** La cortesia in coda («…, please»): non cambia cosa si chiede. */
const TAIL_COURTESY = /[\s,.!]*(please|pls|per favore|per piacere|grazie|thanks)?[\s.!]*$/;

const ENGLISH = /\b(english|inglese)\b/;
const ITALIAN = /\b(italian|italiano)\b/;
const LANGUAGE_WORD = /\b(interface|language|ui|app|lingua|interfaccia)\b/;

/** Mostrare o filtrare le task, in testa. */
const SHOW =
  /^(show|list|display|filter|mostra|mostrami|fammi vedere|elenca|elencami|filtra|filtrami)\b/;
const SHOW_INF = /^(show|list|display|filter|mostrare|mostrarmi|elencare|filtrare|vedere)\b/;
const TASKS = /\btasks?\b/;
const TASK_CODE = /\b[a-z]{2,4}-\d+\b/i;

const SAVE = /^(save|salva|salvami|memorizza)\b/;
const SAVE_INF = /^(save|salvare|salvarmi|memorizzare)\b/;
const FILTER_WORD = /\b(filters?|filtro|filtri)\b/;

const OPEN_FAMILIES: FilterCriteria["families"] = ["todo", "active"];
const STALLED = /\b(stalled|stuck|ferme|ferma|bloccate)\b/;
const CLOSED = /\b(done|closed|finished|chiuse|completate|finite)\b/;
const ALL = /\b(all|tutte)\b/;
const MINE = /\b(my|mie|miei)\b/;
/** «assigned to X», «di X», «by X»: chi si chiede, col nome maiuscolo come lo scrive chi chiede. */
const ASSIGNEE = /\b(?:assigned to|assegnate a|by|di|of|for|per)\s+([A-Z][a-zà-ù]+)\b/;
/** Un giorno o un mese dopo «for/di» («for Friday») non è una persona (M1). */
const WHEN_WORD =
  /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|yesterday|january|february|march|april|may|june|july|august|september|october|november|december|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|domani|ieri|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)$/;
/** Un codice di progetto davanti a «tasks» («show ACQ tasks»), anche di un progetto che non si vede. */
const CODE_TASKS = /\b([A-Z]{2,4})\s+tasks?\b/;
/** Il nome del filtro dopo «as/come» (senza virgolette). */
const NAMED = /\b(?:as|called|named|come|chiamato|col nome)\s+(.+)$/i;

type Request =
  | { kind: "theme"; to: "dark" | "light" | "system" }
  | { kind: "language"; to: "en" | "it" }
  | { kind: "filter" }
  | { kind: "save" };

/** Che cosa chiede la frase; `null` se non è un'azione della pagina. */
function requestOf(text: string): Request | null {
  if (isHowToQuestion(text)) return null;
  const { polite, command: raw } = stripCourtesy(normalize(text));
  // Una domanda («what theme am I using?») si legge, non cambia niente.
  if (!polite && QUESTION.test(raw)) return null;
  const command = raw.replace(TAIL_COURTESY, "");
  const verb = (imperative: RegExp, infinitive: RegExp) =>
    imperative.exec(command) ?? (polite ? infinitive.exec(command) : null);

  const switched = verb(SWITCH, SWITCH_INF);
  const theme = DARK.test(command)
    ? "dark"
    : LIGHT.test(command)
      ? "light"
      : SYSTEM.test(command)
        ? "system"
        : null;
  // Il tema: col verbo in testa, o da solo. «crea una task per il tema
  // scuro» resta una creazione: un altro verbo in testa non è un tema.
  if (theme && (switched || BARE_THEME.test(command))) return { kind: "theme", to: theme };
  if (switched) {
    const to = ENGLISH.test(command) ? "en" : ITALIAN.test(command) ? "it" : null;
    // «metti la descrizione in inglese» non è la lingua dell'interfaccia.
    if (to && (LANGUAGE_WORD.test(command) || SWITCH_TO.test(switched[0]))) {
      return { kind: "language", to };
    }
  }
  const shown = verb(SHOW, SHOW_INF);
  // La giornata e lo stato hanno le loro risposte (I3): «show me my tasks for today» è `today`.
  if (
    shown &&
    TASKS.test(command) &&
    !TASK_CODE.test(command) &&
    !/\bhow\b/.test(command) &&
    !TODAY.test(command) &&
    !STATUS.test(command)
  ) {
    return { kind: "filter" };
  }
  const saved = verb(SAVE, SAVE_INF);
  if (saved && FILTER_WORD.test(command.slice(saved[0].length))) return { kind: "save" };
  return null;
}

/** La frase chiede di cambiare lingua, tema o filtro, o di salvare il filtro (P10). */
export function isPageRequest(text: string): boolean {
  return requestOf(text) !== null;
}

const say = (text: string): Answer => ({ actions: [], text });
const act = (page: PageAction): Answer => ({ actions: [], text: "", page });

export async function page(text: string, ctx: IntentContext): Promise<Answer> {
  const { t } = ctx;
  const request = requestOf(text);
  // Nella Chat (senza `classify`) nessuno cambierebbe la pagina (P11).
  if (!request || !ctx.classify) return say(t(`${K}.inPanel`));
  switch (request.kind) {
    case "theme":
      return ctx.page?.theme === request.to
        ? say(t(`${K}.already.theme.${request.to}`))
        : act({ kind: "theme", to: request.to });
    case "language":
      return ctx.page?.language === request.to
        ? say(t(`${K}.already.language.${request.to}`))
        : act({ kind: "language", to: request.to });
    case "filter":
      return filter(text, ctx);
    case "save":
      return saveFilter(text, ctx);
  }
}

/** Il filtro delle task di un progetto: progetto, persona, aperte/ferme/chiuse. */
async function filter(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t, personId } = ctx;
  const projects = await read.listProjects();
  const found = findProject(text, projects, ctx.contextProjectId);
  // «show ACQ tasks» di un progetto che non si vede: come uno che non c'è (R-G5).
  const named = found.named ?? (found.project ? null : (CODE_TASKS.exec(text)?.[1] ?? null));
  if (named && !found.project) {
    return say(t("claude.answers.status.projectNotFound", { code: named }));
  }
  const project = found.project;
  if (!project) return say(t(`${K}.noProject`));

  const plain = normalize(text);
  const people = await read.listPeople();
  const asked = ASSIGNEE.exec(text)?.[1] ?? null;
  const person = MINE.test(plain)
    ? (people.find((p) => p.id === personId) ?? null)
    : findPerson(text, people, personId);
  // Un nome che non trovo (o di chi non vedo): lo dico, non filtro altro. Non
  // lo è una parola del nome o del codice di un progetto visibile («le task di
  // Portale utenti…»), né un giorno o un mese («for Friday», M1).
  const word = asked ? normalize(asked) : null;
  const notAPerson =
    word !== null &&
    (WHEN_WORD.test(word) ||
      projects.some(
        (p) => normalize(p.code) === word || normalize(p.name).split(/\s+/).includes(word),
      ));
  if (!person && asked && !notAPerson) {
    return say(t(`${K}.noPerson`, { name: asked }));
  }

  const filters: FilterCriteria = {};
  if (person) filters.assigneeIds = [person.id];
  if (CLOSED.test(plain)) filters.families = ["closed"];
  else if (!ALL.test(plain)) filters.families = OPEN_FAMILIES;
  if (STALLED.test(plain)) filters.stalled = true;
  return act({ kind: "filter", route: `/p/${project.code}/tasks`, search: { filters } });
}

/** Il nome del filtro: fra virgolette, o dopo «as/come». */
function filterName(text: string): string | null {
  const quoted = findTitle(text);
  if (quoted) return quoted;
  const named = NAMED.exec(text)?.[1]
    ?.trim()
    .replace(/[.?!]+$/, "");
  return named || null;
}

/** «Salva questo filtro come …»: `saveFilter` del catalogo, privato (P21). */
async function saveFilter(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t } = ctx;
  const last = ctx.page?.lastFilter ?? null;
  if (!last) return say(t(`${K}.needFilter`));
  const name = filterName(text);
  if (!name) return say(t(`${K}.needName`));
  const code = /^\/p\/([A-Z]{2,4})\/tasks$/.exec(last.route)?.[1] ?? null;
  const project = code ? (await read.listProjects()).find((p) => p.code === code) : undefined;
  // Il progetto del filtro non si vede più: come uno che non c'è.
  if (code && !project) return say(t("claude.answers.status.projectNotFound", { code }));
  const criteria: FilterCriteria = {
    ...(parseCriteria(last.search.filters) ?? {}),
    ...(project ? { projectIds: [project.id] } : {}),
  };
  const action: ProposedAction = {
    fn: "saveFilter",
    args: { name, visibility: "private", criteria, view: "list", groupBy: "status" },
    ...summarized(t, `${K}.saveSummary`, { name }),
  };
  const verdict = await byClass(ctx, action, t(`${K}.saved`, { name }), t(`${K}.proposed`));
  return { actions: [], ...verdict };
}
