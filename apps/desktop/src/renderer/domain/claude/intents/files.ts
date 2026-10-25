import type { CitationRef, DriveFile } from "../../../data/types";
import { labelled, resulted, type Answer } from "../answers";
import type { IntentContext, T } from "../context";
import { findProject, normalize, topicWords } from "../parse";

// «Cosa dice il contratto col cliente sui tempi di consegna?» (area 5): Claude
// legge i file del Drive dei progetti che chi chiede vede — solo quelli che
// gli arrivano da `read.readDriveFiles` (visibili, non nascosti, disponibili,
// pronti), che non contano aperture — e cita il file col passaggio. Un file
// che chi chiede non vede non gli arriva: la risposta è quella di un file che
// non esiste (R-G5). Se nessun file ne parla lo dice: non inventa.

/** La domanda su un file: di quale file («il contratto col cliente») e su cosa («i tempi di consegna»). */
export interface FileQuestion {
  subject: string;
  topic: string;
  /** Il codice del file, se il soggetto è un codice («What does AUD-F7 say…»). */
  code: string | null;
}

/** Un file del Drive citato: l'id e il codice di adesso, che la citazione ricorda (R-H5). */
export const driveRef = (file: Pick<DriveFile, "id" | "code">): CitationRef => ({
  kind: "drive",
  id: file.id,
  code: file.code,
});

const FILE_CODE = /\b([a-z]{2,4})-f(\d+)\b/i;

const EN =
  /\bwhat (?:does|do|did) (?:the |our |a |an |that |this )?(.+?) (?:say|says|state|states) (?:about|on|regarding|for) (.+)$/;
const IT =
  /\b(?:cosa|che cosa) (?:dice|dicono|prevede|prevedono|scrive|riporta) (?:il |lo |la |l'|i |gli |le )?(.+?) (?:(?:su|sul|sullo|sulla|sui|sugli|sulle|circa|riguardo a|riguardo ai|riguardo alle|a proposito di|per) |sull')(.+)$/;

/**
 * La domanda su un file, o `null` se il messaggio non lo è. Il soggetto deve
 * dire che si parla di un file: un nome di documento («il contratto», «the
 * spreadsheet», «il file») o il codice di un file (`AUD-F7`). «What does
 * Laura say about X» parla di una persona, non di un file.
 */
export function fileQuestion(text: string): FileQuestion | null {
  const plain = normalize(text).replace(/[?!.]+\s*$/, "");
  const m = EN.exec(plain) ?? IT.exec(plain);
  if (!m) return null;
  const subject = m[1]!.trim();
  const topic = m[2]!.trim();
  if (topicWords(topic).length === 0) return null;
  const coded = FILE_CODE.exec(subject);
  if (coded) return { subject, topic, code: `${coded[1]!.toUpperCase()}-F${coded[2]}` };
  const words = topicWords(subject);
  const isFile = words.some((w) => DOCUMENT_NOUNS.has(w) || GENERIC_NOUNS.has(w));
  return isFile ? { subject, topic, code: null } : null;
}

// Le parole italiane più comuni dei documenti di progetto, con la loro forma
// inglese: i file del seme sono scritti in inglese, i nomi spesso in italiano.
const SYNONYMS: Record<string, string> = {
  contratto: "contract",
  cliente: "client",
  tempi: "times",
  tempo: "time",
  consegna: "delivery",
  consegne: "delivery",
  penale: "penalty",
  penali: "penalty",
  ritardo: "delay",
  ritardi: "delay",
  preventivo: "quote",
  scadenza: "deadline",
  pagamento: "payment",
  pagamenti: "payment",
  fattura: "invoice",
  fatturazione: "invoicing",
  verbale: "minutes",
  specifiche: "specification",
  riunione: "meeting",
  durata: "term",
  rinnovo: "renew",
  collaudo: "acceptance",
};

/** I nomi che dicono DI QUALE file si parla: se la domanda ne ha uno, il nome del file deve averlo. */
const DOCUMENT_NOUNS = new Set([
  "contract",
  "contratto",
  "quote",
  "preventivo",
  "minutes",
  "verbale",
  "notes",
  "note",
  "presentation",
  "presentazione",
  "deck",
  "specification",
  "specifications",
  "specifiche",
  "roadmap",
  "brief",
  "report",
  "catalog",
  "catalogo",
  "listino",
  "calendar",
  "calendario",
  "requirements",
  "requisiti",
  "offer",
  "offerta",
]);

/**
 * I nomi generici di un file: dicono che si parla di un file ma non di
 * quale. Non filtrano il nome; foglio, slide e PDF filtrano il tipo.
 */
const GENERIC_NOUNS = new Map<string, DriveFile["type"] | null>([
  ["file", null],
  ["files", null],
  ["document", null],
  ["documents", null],
  ["documento", null],
  ["documenti", null],
  ["doc", null],
  ["sheet", "sheet"],
  ["spreadsheet", "sheet"],
  ["foglio", "sheet"],
  ["slides", "slides"],
  ["slide", "slides"],
  ["pdf", "pdf"],
]);

/** Le radici di una parola (5 lettere delle lunghe), anche nella forma inglese. */
function roots(word: string): string[] {
  const root = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);
  const forms = [word, SYNONYMS[word]].filter((w): w is string => !!w);
  return [...new Set(forms.map(root))];
}

const hits = (word: string, hay: string) => roots(word).some((r) => hay.includes(r));

/** Il paragrafo del testo che parla di più parole del tema (il primo, a pari merito). */
function passageOf(text: string, topic: readonly string[]): string {
  let best = "";
  let bestScore = 0;
  for (const paragraph of text.split(/\n\s*\n/)) {
    const hay = normalize(paragraph);
    const score = topic.filter((w) => hits(w, hay)).length;
    if (score > bestScore) {
      best = paragraph.trim();
      bestScore = score;
    }
  }
  return best;
}

export interface FilesFound {
  file: DriveFile;
  passage: string;
  /** Il numero dell'articolo, se il passaggio comincia con «3. …». */
  article: string | null;
}

/**
 * Il file che risponde alla domanda, fra quelli che chi chiede può leggere:
 * se la domanda nomina un tipo di documento («il contratto») il nome del file
 * deve averlo; poi conta il resto del soggetto (nel nome 2, nel testo 1) e il
 * tema nel testo (1 a parola). Senza il tema nel testo, nessun file.
 */
export function findInFiles(q: FileQuestion, files: readonly DriveFile[]): FilesFound | null {
  const topic = topicWords(q.topic);
  // Un codice dice il file: lui, se chi chiede lo legge (altrimenti nessuno,
  // come un codice che non esiste). Il passaggio è quello del tema, se c'è.
  if (q.code) {
    const file = files.find((f) => f.code === q.code);
    if (!file) return null;
    const passage = passageOf(file.text, topic) || (file.summary ?? "");
    return { file, passage, article: /^(\d+)\.\s/.exec(passage)?.[1] ?? null };
  }
  const subject = topicWords(q.subject);
  const nouns = subject.filter((w) => DOCUMENT_NOUNS.has(w));
  const types = subject.flatMap((w) => GENERIC_NOUNS.get(w) ?? []);
  const rest = subject.filter((w) => !DOCUMENT_NOUNS.has(w) && !GENERIC_NOUNS.has(w));
  let best: { file: DriveFile; score: number } | null = null;
  for (const file of files) {
    const name = normalize(file.name);
    const body = normalize(`${file.summary ?? ""} ${file.text}`);
    if (!nouns.every((w) => hits(w, name))) continue;
    if (!types.every((type) => file.type === type)) continue;
    const about = topic.filter((w) => hits(w, normalize(file.text))).length;
    if (about === 0) continue;
    const score = about + rest.reduce((s, w) => s + (hits(w, name) ? 2 : hits(w, body) ? 1 : 0), 0);
    if (!best || score > best.score) best = { file, score };
  }
  if (!best) return null;
  const passage = passageOf(best.file.text, topic);
  return { file: best.file, passage, article: /^(\d+)\.\s/.exec(passage)?.[1] ?? null };
}

/** Il testo della risposta che cita il file: codice + nome, il Drive del progetto, il passaggio. */
export function filesFoundText(t: T, found: FilesFound, projectCode: string): string {
  const params = { code: found.file.code, name: found.file.name, project: projectCode };
  const lead = found.article
    ? t("claude.answers.files.foundArticle", { ...params, article: found.article })
    : t("claude.answers.files.found", params);
  return `${lead}\n\n> ${found.passage}`;
}

/**
 * «Cosa dice <file> su <tema>»: cerca nei file del Drive (del progetto
 * nominato, o di tutti i progetti che chi chiede vede) e cita il file.
 */
export async function files(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t } = ctx;
  const q = fileQuestion(text)!;
  const projects = await read.listProjects();
  // Solo un progetto NOMINATO restringe la ricerca (il contesto no: il
  // contratto di AUD si chiede anche da un altro canale). Un progetto
  // nominato che non si vede cerca nel vuoto, come uno che non esiste.
  const { project, named } = findProject(text, projects, null);
  const all = await read.readDriveFiles();
  const scope = named ? all.filter((f) => f.projectId === project?.id) : all;
  const found = findInFiles(q, scope);
  const action = {
    tool: "search_drive",
    ...labelled(t, "claude.answers.actions.searchDrive", { topic: q.topic }),
    ...resulted(t, "claude.answers.actions.files", { count: found ? 1 : 0 }),
  };
  if (!found) {
    return { actions: [action], text: t("claude.answers.files.nothing", { topic: q.topic }) };
  }
  const code = projects.find((p) => p.id === found.file.projectId)?.code ?? "";
  const refs: CitationRef[] = [driveRef(found.file)];
  return { actions: [action], text: filesFoundText(t, found, code), refs };
}
