import { TODAY } from "../../../data/dates";
import type { MailMessageView, MailThreadDetail, Project, Task } from "../../../data/types";
import { sayDate } from "../answers";
import type { T } from "../context";
import { normalize, topicWords } from "../parse";

// La bozza di Claude nella Posta («Chiedi a Claude»): il prototipo non
// chiama un modello, quindi costruisce un testo finto dall'ultimo messaggio
// della conversazione, dal progetto (le task aperte e quelle in ritardo) e
// dall'indicazione di chi scrive. Puro, come gli altri intenti: legge solo da
// `ctx.read`, che il chiamante (`data/mail/compose.ts`) limita a ciò che la
// persona vede — conversazione, progetti e task visibili (`visibleTasks`) —
// quindi la bozza non cita mai una task di un progetto che non vede. I miei
// messaggi inviati fanno parte della conversazione e la bozza può leggerli
// (è la mia posta): R-I8 tiene fuori la posta in uscita solo dalla
// classificazione, non da qui. Non
// scrive nulla e non invia MAI: restituisce un testo, che `compose.ts`
// porta nel campo in streaming e che chi scrive modifica prima di «Invia».

/** Le task citate al massimo: due in ritardo, due aperte che c'entrano. */
const MAX_LATE = 2;
const MAX_WORKING = 2;

export interface MailDraftRequest {
  /** La conversazione a cui si risponde; `null` = email nuova (serve `hint`). */
  threadId: string | null;
  /** L'indicazione facoltativa («digli che slitta a giovedì»). */
  hint: string;
  /** Il progetto scelto per un'email nuova («About: MKX»), facoltativo. */
  projectId?: string | null;
}

/** Le letture della bozza, già limitate a chi scrive. */
export interface MailDraftReads {
  /** La conversazione come la vede chi scrive; `null` se non la vede. */
  thread(threadId: string): Promise<MailThreadDetail | null>;
  /** I progetti che chi scrive vede. */
  projects(): Promise<Project[]>;
  /** Le task aperte (non chiuse) del progetto che chi scrive vede. */
  openTasks(projectId: string): Promise<Task[]>;
}

export interface MailDraftContext {
  personId: string;
  /** Il nome di chi scrive, per la firma. */
  personName: string;
  read: MailDraftReads;
  t: T;
}

/** Una task che la bozza ha usato («Used: MKX-91 Banner review (late)»). */
export interface MailDraftUse {
  taskId: string;
  code: string;
  title: string;
  late: boolean;
}

export interface MailDraftResult {
  text: string;
  /** Il progetto da cui ha letto le task, se c'è (per «… e da MKX»). */
  projectId: string | null;
  used: MailDraftUse[];
}

/**
 * In ritardo: scadenza passata, o già slittata di settimana in settimana.
 * «Oggi» è l'orologio fisso del prototipo.
 */
export const isLate = (task: Task): boolean =>
  (task.dueDate !== null && task.dueDate < TODAY) || task.slipCount > 0;

/** Un'indicazione detta come comando diventa la frase: «digli che arriva giovedì» → «Arriva giovedì.». */
export function hintSentence(hint: string): string {
  const rest = hint
    .trim()
    .replace(
      /^(please\s+)?(tell|let)\s+(them|him|her)(\s+know)?(\s+that)?\s+|^(please\s+)?say\s+(that\s+)?/i,
      "",
    )
    .replace(
      /^(digli|dille|ditegli|di'\s+loro|dì\s+loro|scrivigli|scrivile|rispondigli|rispondile)(\s+che)?\s+/i,
      "",
    )
    .trim();
  if (rest === "") return "";
  const sentence = rest[0]!.toUpperCase() + rest.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

const bareSubject = (subject: string) => subject.replace(/^((re|fwd?|r|i)\s*:\s*)+/i, "").trim();

/** L'ultimo messaggio arrivato davvero (non un mio invio in corso o fallito). */
function lastMessage(thread: MailThreadDetail): MailMessageView | undefined {
  return [...thread.messages].reverse().find((m) => !m.delivery || m.delivery.state === "sent");
}

/** A chi si rivolge: il mittente dell'ultimo messaggio, o il suo primo destinatario se l'ho scritto io. */
function addressee(me: string, m: MailMessageView): string | null {
  const other = m.from.personId === me ? m.to[0] : m.from;
  return other ? firstName(other.name || other.email) : null;
}

/** Il progetto della conversazione: il primo, dal messaggio più recente, fra quelli che vedo. */
function threadProject(thread: MailThreadDetail, visible: Set<string>): string | null {
  for (const m of [...thread.messages].reverse()) {
    if (m.classification.state !== "done") continue;
    const id = m.classification.projectIds.find((p) => visible.has(p));
    if (id) return id;
  }
  return null;
}

/**
 * Scrive la bozza. Una conversazione che chi scrive non vede, o un progetto
 * scelto che non vede, è `not_found` (R-G5); un'email nuova senza
 * indicazione è `invalid: hint` (non c'è nulla da cui partire).
 */
export async function draftReply(
  request: MailDraftRequest,
  ctx: MailDraftContext,
): Promise<MailDraftResult> {
  const { read, t } = ctx;
  const thread = request.threadId === null ? null : await read.thread(request.threadId);
  if (request.threadId !== null && thread === null) throw new Error("not_found");
  const hint = hintSentence(request.hint);
  if (thread === null && hint === "") throw new Error("invalid: hint");

  const projects = await read.projects();
  const visible = new Set(projects.map((p) => p.id));
  let projectId: string | null = null;
  if (request.projectId) {
    if (!visible.has(request.projectId)) throw new Error("not_found");
    projectId = request.projectId;
  } else if (thread) {
    projectId = threadProject(thread, visible);
  }

  const last = thread ? lastMessage(thread) : undefined;
  const name = last ? addressee(ctx.personId, last) : null;
  const lines: string[] = [
    name ? t("claude.mailDraft.greeting", { name }) : t("claude.mailDraft.greetingAll"),
  ];
  const body: string[] = [];
  if (last) body.push(t("claude.mailDraft.thanks", { subject: bareSubject(last.subject) }));
  if (hint) body.push(hint);

  const used: MailDraftUse[] = [];
  if (projectId) {
    const tasks = await read.openTasks(projectId);
    // Le parole che contano: quelle dell'ultimo messaggio e dell'indicazione.
    const topic = new Set(
      topicWords(`${last?.subject ?? ""} ${last?.text ?? ""} ${request.hint}`).filter(
        (w) => w.length >= 4,
      ),
    );
    const relevant = (task: Task) => topicWords(normalize(task.title)).some((w) => topic.has(w));
    const byCode = (a: Task, b: Task) => a.code.localeCompare(b.code, "en", { numeric: true });
    const late = tasks
      .filter(isLate)
      .sort((a, b) => Number(relevant(b)) - Number(relevant(a)) || byCode(a, b))
      .slice(0, MAX_LATE);
    const working = tasks
      .filter((task) => !isLate(task) && relevant(task))
      .sort(byCode)
      .slice(0, MAX_WORKING);
    for (const task of late) {
      body.push(
        task.dueDate !== null && task.dueDate < TODAY
          ? t("claude.mailDraft.lateDue", { title: task.title, date: sayDate(t, task.dueDate) })
          : t("claude.mailDraft.late", { title: task.title }),
      );
    }
    if (working.length > 0) {
      body.push(
        t("claude.mailDraft.working", {
          titles: working.map((w) => t("claude.mailDraft.quoted", { title: w.title })).join(", "),
        }),
      );
    }
    for (const task of [...late, ...working]) {
      used.push({ taskId: task.id, code: task.code, title: task.title, late: isLate(task) });
    }
  }

  if (body.length === 0) body.push(t("claude.mailDraft.fallback"));
  lines.push("", body.join(" "), "", t("claude.mailDraft.closing", { name: ctx.personName }));
  return { text: lines.join("\n"), projectId, used };
}

/**
 * La bozza di Claude nel campo, quando il corpo ha già del testo: «Replace»
 * la sostituisce, «Add below» la mette sotto. Claude non sovrascrive mai in
 * silenzio: la scelta è di chi scrive (shape [A 10]).
 */
export function placeDraft(body: string, draft: string, how: "replace" | "below"): string {
  if (how === "replace" || body.trim() === "") return draft;
  return `${body.replace(/\s+$/, "")}\n\n${draft}`;
}
