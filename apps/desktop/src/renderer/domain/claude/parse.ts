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

export interface CodeRef {
  /** Il codice in maiuscolo, es. `AUD-3` o `STW-R4`. */
  code: string;
  projectCode: string;
  kind: "task" | "request";
}

/** I codici di catalogo nel testo (`[A-Z]{2,4}-R?\d+`), nell'ordine, senza doppi. */
export function findCodes(text: string): CodeRef[] {
  const out: CodeRef[] = [];
  for (const m of text.matchAll(/\b([a-z]{2,4})-(r?)(\d+)\b/gi)) {
    const code = m[0].toUpperCase();
    if (out.some((c) => c.code === code)) continue;
    out.push({ code, projectCode: m[1]!.toUpperCase(), kind: m[2] ? "request" : "task" });
  }
  return out;
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
  const codes = findCodes(text);
  if (codes[0]) return { project: byCode(codes[0].projectCode), named: codes[0].projectCode };
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
