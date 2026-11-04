import type { Person, Project, TaskSize } from "../../data/types";
import { addWeeks, currentWeek } from "../weeks";

// La lettura del messaggio: codici, progetto, persona, settimana, titolo,
// taglia. Funzioni pure sul testo e sugli elenchi che il chiamante ha già
// letto (quindi solo ciò che la persona vede).

/** Il testo per cercarci le parole chiave: minuscolo, senza accenti, apostrofi dritti. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Comando o domanda (spostati qui da `intents.ts` per gli intenti che li
// riconoscono da sé, come `refused.ts`).
/** Un saluto in testa («Ciao,», «Hi»): non cambia cosa si chiede. */
const GREETING = /^(ciao|salve|buongiorno|buonasera|hi|hello|hey)\b[,!.]?\s*/;
/**
 * Una cortesia in testa: dopo di lei il verbo può essere all'infinito
 * («Puoi creare…», «Vorrei avviare…») e un «?» finale non fa una domanda.
 */
const POLITE =
  /^(please|pls|kindly|per favore|per piacere|can you|could you|would you|will you|i'd like you to|i would like you to|i'd like to|i want to|puoi|mi puoi|ci puoi|potresti|mi potresti|riesci a|vorrei che|vorrei|ti chiedo di)\b[,!]?\s*/;
/** Toglie saluti e cortesie in testa (anche in fila: «Ciao, per favore, puoi…»). */
export function stripCourtesy(plain: string): { polite: boolean; command: string } {
  let command = plain.replace(GREETING, "");
  let polite = false;
  for (let m = POLITE.exec(command); m && m[0].length > 0; m = POLITE.exec(command)) {
    polite = true;
    command = command.slice(m[0].length);
  }
  return { polite, command };
}
/**
 * Il lead di una domanda «come si fa / come funziona». Non «how is / how
 * are»: chiedono com'è una cosa («How are we spending on AI?»), non come si fa.
 */
const HOWTO_QUESTION =
  /^(how (do|does|can|to|should)|come (funziona|funzionano|si|faccio|posso|fare|devo))\b/;
/**
 * Una domanda «come si fa / come funziona» in testa (dopo saluti e
 * cortesie): «How do I mark a task as stalled?», «Come si imposta il
 * budget?». Il controllo UNICO che i riconoscitori dell'area 10b (automazione,
 * fermi, spesa, e quelli che verranno) usano per lasciarla a `howto`, invece
 * di ripetere ognuno la sua esclusione (ruling T6 I1). «How much…» non lo è.
 */
export function isHowToQuestion(text: string): boolean {
  return HOWTO_QUESTION.test(stripCourtesy(normalize(text)).command);
}

/**
 * Le parole della giornata («today», «oggi») e dello stato dei progetti:
 * condivise fra `recognize` e i riconoscitori che non devono rubarle (le
 * azioni della pagina, area 10b: «mostrami le mie task di oggi» resta `today`).
 */
export const TODAY =
  /\b(today|my day|what should i do|what do i have|oggi|cosa devo fare|cosa ho da fare|la mia giornata)\b/;
export const STATUS =
  /\b(status|where (are|do) .*projects?|how are .*projects?|how's .*going|a che punto|come vanno|come va|stato dei progetti|situazione)\b/;

/** Una domanda: il punto interrogativo, o una parola interrogativa in testa. */
export const QUESTION =
  /(\?\s*$)|^(when|why|did|does|do|who|whom|whose|what|what's|how|is|are|was|were|has|have|had|which|where|quando|perche|chi|cosa|che cosa|come|e|era|sono|ha|hanno|quale|quali|dove)\b/;

export interface CodeRef {
  /** Il codice in maiuscolo, es. `AUD-3` o `STW-R4`. */
  code: string;
  projectCode: string;
  kind: "task" | "request";
  /**
   * Il prefisso è un progetto che la persona vede. Un codice maiuscolo di un
   * prefisso ignoto resta un codice («AUD-3» per chi non vede AUD: «non la
   * trovo»), ma può anche essere una sigla («UTF-8»): chi riconosce l'intento
   * lo pesa meno di un codice noto.
   */
  known: boolean;
}

/**
 * I codici di catalogo nel testo (`[A-Z]{2,4}-R?\d+`), nell'ordine, senza
 * doppi. Maiuscoli, come li scrive il Catalogo; in minuscolo («aud-3») solo
 * se il prefisso è un progetto visibile (`visibleCodes`), così «utf-8» o
 * «e-mail-2» non diventano codici. Senza `visibleCodes` ogni codice
 * maiuscolo conta come noto.
 */
export function findCodes(text: string, visibleCodes?: ReadonlySet<string>): CodeRef[] {
  const out: CodeRef[] = [];
  for (const m of text.matchAll(/\b([a-z]{2,4})-(r?)(\d+)\b/gi)) {
    const projectCode = m[1]!.toUpperCase();
    const upper = m[1] === projectCode && (m[2] === "" || m[2] === "R");
    const known = visibleCodes ? visibleCodes.has(projectCode) : upper;
    if (!upper && !known) continue;
    const code = m[0].toUpperCase();
    if (out.some((c) => c.code === code)) continue;
    out.push({ code, projectCode, kind: m[2] ? "request" : "task", known });
  }
  return out;
}

/** Il testo con i codici in minuscolo di progetti visibili riscritti in maiuscolo («aud-3» → «AUD-3»). */
export function canonicalCodes(text: string, visibleCodes: ReadonlySet<string>): string {
  return text.replace(/\b([a-z]{2,4})-(r?)(\d+)\b/gi, (match, prefix: string) =>
    visibleCodes.has(prefix.toUpperCase()) ? match.toUpperCase() : match,
  );
}

/** Le parole di un nome che bastano a riconoscerlo: lunghe e di un solo progetto. */
function distinctiveWord(project: Project, projects: Project[]): string | null {
  const first = normalize(project.name).split(" ")[0] ?? "";
  if (first.length < 5) return null;
  const shared = projects.filter((p) => normalize(p.name).split(" ")[0] === first).length;
  return shared === 1 ? first : null;
}

/**
 * Il progetto di cui parla il messaggio: quello di un codice citato, un
 * codice di progetto scritto da solo (in maiuscolo), il nome; altrimenti il
 * contesto della conversazione. Solo fra i progetti che la persona vede.
 */
export function findProject(
  text: string,
  projects: Project[],
  contextProjectId: string | null,
): { project: Project | null; named: string | null } {
  const byCode = (code: string) => projects.find((p) => p.code === code) ?? null;
  // Solo il codice di un progetto visibile dice il progetto: «UTF-8» non è
  // un progetto, e un progetto invisibile si riconosce dalla preposizione.
  for (const c of findCodes(text)) {
    const project = byCode(c.projectCode);
    if (project) return { project, named: c.projectCode };
  }
  for (const m of text.matchAll(/\b[A-Z]{2,4}\b/g)) {
    const project = byCode(m[0]);
    if (project) return { project, named: m[0] };
  }
  // «in AUD» di un progetto che non vede: nominato ma non trovato — non si
  // cerca altrove, e la risposta è la stessa di un codice che non esiste.
  // Senza preposizione una sigla («CSV», «PDF») non è un progetto.
  const asked = /\b(?:in|on|for|of|di|del|nel|per)\s+([A-Z]{2,4})\b/.exec(text);
  if (asked) return { project: null, named: asked[1]! };
  const plain = normalize(text);
  for (const p of projects) {
    const word = distinctiveWord(p, projects);
    if (plain.includes(normalize(p.name)) || (word && new RegExp(`\\b${word}\\b`).test(plain))) {
      return { project: p, named: p.code };
    }
  }
  const context = projects.find((p) => p.id === contextProjectId) ?? null;
  return { project: context, named: null };
}

/**
 * La persona nominata: «me»/«myself» dopo «to/for/a/per» è chi scrive; poi
 * il nome intero, poi il nome proprio se è di una sola persona.
 */
export function findPerson(text: string, people: Person[], me: string): Person | null {
  const plain = normalize(text);
  const humans = people.filter((p) => !p.isClaude);
  if (/\b(to|for|a|per)\s+(me|myself|me stess[oa])\b/.test(plain)) {
    return humans.find((p) => p.id === me) ?? null;
  }
  const full = humans.find((p) => plain.includes(normalize(p.name)));
  if (full) return full;
  const firstName = (p: Person) => normalize(p.name).split(" ")[0]!;
  const matches = humans.filter((p) => new RegExp(`\\b${firstName(p)}\\b`).test(plain));
  const unique = matches.filter(
    (p) => humans.filter((h) => firstName(h) === firstName(p)).length === 1,
  );
  return unique[0] ?? null;
}

/** La settimana nominata («next week», «settimana prossima», «W44»), sull'orologio fisso. */
export function findWeek(text: string): string | null {
  const plain = normalize(text);
  const now = currentWeek();
  if (/\b(next week|prossima settimana|settimana prossima)\b/.test(plain)) return addWeeks(now, 1);
  if (/\b(this week|questa settimana)\b/.test(plain)) return now;
  const explicit = /\b(?:(\d{4})-)?w(\d{1,2})\b/.exec(plain);
  if (explicit) {
    const year = explicit[1] ?? now.slice(0, 4);
    return `${year}-W${explicit[2]!.padStart(2, "0")}`;
  }
  return null;
}

/** Il titolo fra virgolette (dritte, curve, caporali) o dopo i due punti. */
export function findTitle(text: string): string | null {
  const quoted = /["“«]([^"”»]{2,})["”»]/.exec(text);
  if (quoted) return quoted[1]!.trim();
  const colon = /:\s*(.{2,})$/.exec(text);
  return colon ? colon[1]!.trim().replace(/[.?!]+$/, "") : null;
}

/** La taglia, solo se annunciata («size M», «taglia S»): una «M» da sola è troppo ambigua. */
export function findSize(text: string): TaskSize | null {
  const m = /\b(?:size|taglia)\s+(XS|XL|S|M|L)\b/i.exec(text);
  return m ? (m[1]!.toUpperCase() as TaskSize) : null;
}

const STOPWORDS = new Set(
  (
    "the a an of in on for to do does did how work works working is are be i we you can with what and my our it " +
    "about there that this when where why which " +
    "il lo la i gli le un uno una di del dello della dei degli delle in nel nello nella nei negli nelle su sul " +
    "sulla per come funziona funzionano funzionare si fa fanno faccio posso possiamo e che cosa a al alla da " +
    "con mi ci ti vi l un' quando dove perche quale"
  ).split(" "),
);

/** Le parole che contano di un tema, senza le parole vuote (en/it). */
export function topicWords(topic: string): string[] {
  return normalize(topic)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}
