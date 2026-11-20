import { ApiError } from "@stubwise/api-client";
import { claudeVisibilityConfirmationSchema, DOC_CODE_RE, docCodeResolutionSchema } from "@stubwise/shared";
import type {
  ProjectRequestSummary,
  ClaudeConversation,
  ClaudeConversationContext,
  ClaudeConversationDetail as ClaudeConversationDetailView,
  Reader,
  SearchDocHit,
} from "@stubwise/shared";
import type * as Fake from "../../api";
import type {
  AiBlock,
  CitationRef,
  CitationView,
  ContextRef,
  Conversation,
  ConversationDetail,
  ConversationRow,
  MentionResult,
  SlashCommand,
} from "../../types";
import i18n from "../../../i18n";
import { appClient, session } from "./client";
import { listPeople } from "./people";
import { chatCitationView } from "./chat";
import { listProjects } from "./projects";
import { getRequest, getRequestByCode } from "./requests";
import { getTaskByCode, listTasks } from "./tasks";
import { featureIntegrated } from "../../integration";
import { splitThreadKey } from "./mailKeys";
import { drive } from "./drive";

// La chat con Claude nella build app (integrazione «Chat con Claude», fetta 2):
// le conversazioni libere PRIVATE di chi le apre (`/api/claude/conversations`).
// Messaggi, «Ferma», eventi e stream sono quelli delle sessioni: la
// conversazione È una sessione `free`, con lo stesso id. In questa fetta
// Claude legge e risponde, e basta: niente pubbliche, niente proposte né
// azioni. Il contesto arriva al server come `tipo: id`.

type View = Reader<ClaudeConversation>;

/** Il budget del mese finito: lo stesso errore del prototipo (`isBudgetRefusal`). */
const budgetRefusal = () => new Error("invalid: monthly_budget");

/** Le risposte di rifiuto del server negli errori del prototipo. */
export async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === "budget_exhausted") throw budgetRefusal();
      if (error.code === "conversation_archived") throw new Error("forbidden");
      if (error.status === 404) throw new Error("not_found");
    }
    throw error;
  }
}

/** Il contesto di progetto (quello che decide «/») dal contesto salvato. */
export function contextProjectOf(context: ClaudeConversationContext | null | undefined): string | null {
  return context?.kind === "project" ? context.id : null;
}

/**
 * Il codice di ogni task e richiesta risolta per il chip (dall'indirizzo,
 * `contextIdOf`), PER PERSONA: chi entra dopo non eredita ciò che vedeva
 * un altro.
 */
const codesByPerson = new Map<string, Map<string, string>>();
function codeOfObjectFor(): Map<string, string> {
  const me = session.personId ?? "";
  let codes = codesByPerson.get(me);
  if (!codes) codesByPerson.set(me, (codes = new Map()));
  return codes;
}

export async function taskCodeOf(taskId: string): Promise<{ code: string; projectId: string } | null> {
  try {
    const ticket = await appClient().tickets.get(taskId);
    const code = (await listProjects()).find((p) => p.id === ticket.projectId)?.code;
    return code ? { code: `${code}-${ticket.number}`, projectId: ticket.projectId } : null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** 404 (o 400 di validazione) = l'oggetto non c'è per chi guarda: `null`. */
async function seenOrNull<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

/**
 * Area 10, F1: un'automazione che chi guarda vede, per id o per codice
 * (l'elenco del server è già filtrato coi suoi permessi).
 */
async function visibleAutomation(match: { id?: string; code?: string }) {
  if (!featureIntegrated("automations")) return null;
  const list = await seenOrNull(() => appClient().automations.list({}));
  return (
    list?.items.find((a) => (match.id !== undefined ? a.id === match.id : a.code === match.code)) ?? null
  );
}

/** Area 10, F1: una conversazione di supporto che chi guarda vede, per codice. */
async function visibleSupport(code: string | undefined) {
  if (!code || !featureIntegrated("support")) return null;
  return seenOrNull(() => appClient().support.get(code));
}

/**
 * Area 10, F1: una conversazione della PROPRIA posta (`mailbox_owner`: il
 * server risponde 404 a chiunque altro, admin compresi). La chiave dell'app
 * è `<casella>_<thread>`; al server il contesto è `<casella>/<thread>`, il
 * `ref` di `read_mail_thread` (72).
 */
async function ownMailThread(key: string | null) {
  const parts = key ? splitThreadKey(key) : null;
  if (!parts || !featureIntegrated("mail")) return null;
  const t = await seenOrNull(() => appClient().mail.thread(parts.threadId, parts.accountId));
  return t ? parts : null;
}

/**
 * Area 10, F6: una PR che chi guarda ha letto (`prRefOf`, gli elenchi del
 * server sono già filtrati), con un numero. Importata a chiamata: i rilasci
 * leggono i codici dei progetti da `claude.ts`, che importa questo modulo.
 */
async function seenPr(prId: string) {
  const { prRefOf } = await import("./releasesLive");
  const ref = prRefOf(prId);
  return ref && ref.prNumber > 0 ? ref : null;
}

/**
 * Il contesto di una pagina come lo legge il server: `tipo: id`, dove l'id è
 * ciò con cui il modello lo rilegge coi suoi tool — il CODICE di una task o di
 * una richiesta (`read_task`, `read_request`), l'id di un progetto. I
 * rilasci non danno contesto.
 */
export async function serverContextOf(ref: ContextRef): Promise<ClaudeConversationContext | null> {
  switch (ref.kind) {
    case "task": {
      const code = codeOfObjectFor().get(ref.taskId) ?? (await taskCodeOf(ref.taskId))?.code;
      return code ? { kind: "task", id: code } : null;
    }
    case "request": {
      const code = codeOfObjectFor().get(ref.requestId) ?? (await getRequest(ref.requestId).catch(() => null))?.code;
      return code ? { kind: "request", id: code } : null;
    }
    case "page":
      return ref.projectId ? { kind: "project", id: ref.projectId } : { kind: "page", id: ref.route };
    case "settings":
      return ref.projectId ? { kind: "project", id: ref.projectId } : null;
    // Area 10, F1: gli oggetti che Claude rilegge coi tool nuovi.
    case "automation": {
      const a = await visibleAutomation({ id: ref.automationId });
      return a ? { kind: "automation", id: a.code } : null;
    }
    case "support": {
      const c = await visibleSupport(codeOfObjectFor().get(ref.conversationId));
      return c ? { kind: "support", id: c.code } : null;
    }
    case "mail": {
      const parts = await ownMailThread(ref.threadId);
      return parts ? { kind: "mail", id: `${parts.accountId}/${parts.threadId}` } : null;
    }
    // Area 10, F6: la PR per `read_pull_request_notes` (72): `<repository>:<numero>`.
    case "pr": {
      const pr = await seenPr(ref.prId);
      return pr ? { kind: "pr", id: `${pr.repositoryId}:${pr.prNumber}` } : null;
    }
    default:
      return null;
  }
}

const K = "claude.panel.chip";

/** Il chip: rilegge l'oggetto ADESSO, con la visibilità di chi guarda; invisibile = `null`. */
export const describeContext: typeof Fake.describeContext = async (ref) => {
  switch (ref.kind) {
    case "task": {
      const found = await taskCodeOf(ref.taskId);
      if (!found) return null;
      codeOfObjectFor().set(ref.taskId, found.code);
      return { code: found.code, labelKey: `${K}.kind.task`, projectId: found.projectId };
    }
    case "request": {
      const r = await getRequest(ref.requestId).catch(() => null);
      if (!r) return null;
      codeOfObjectFor().set(ref.requestId, r.code);
      return { code: r.code, labelKey: `${K}.kind.request`, projectId: r.projectId };
    }
    case "page": {
      if (ref.projectId === null) return { code: null, labelKey: `nav.${ref.route}`, projectId: null };
      const project = (await listProjects()).find((p) => p.id === ref.projectId);
      return project ? { code: project.code, labelKey: `project.sections.${ref.route}`, projectId: project.id } : null;
    }
    case "settings": {
      if (ref.projectId === null) return null;
      const project = (await listProjects()).find((p) => p.id === ref.projectId);
      return project
        ? {
            code: project.code,
            labelKey: `${K}.projectSettings`,
            projectId: project.id,
            params: { sectionKey: `settings.sections.${ref.section}` },
          }
        : null;
    }
    // Area 10, F1: automazioni, supporto e la propria posta.
    case "automation": {
      const a = await visibleAutomation({ id: ref.automationId });
      return a ? { code: a.code, labelKey: `${K}.kind.automation`, projectId: a.projectId } : null;
    }
    case "support": {
      const c = await visibleSupport(codeOfObjectFor().get(ref.conversationId));
      return c ? { code: c.code, labelKey: `${K}.kind.support`, projectId: c.projectId } : null;
    }
    case "mail":
      return (await ownMailThread(ref.threadId))
        ? { code: null, labelKey: `${K}.kind.mail`, projectId: null }
        : null;
    case "pr": {
      const pr = await seenPr(ref.prId);
      const code = pr ? (await listProjects()).find((p) => p.id === pr.projectId)?.code : undefined;
      return pr && code
        ? { code, labelKey: `${K}.kind.pr`, projectId: pr.projectId, params: { number: pr.prNumber } }
        : null;
    }
    default:
      // Le aree non integrate (rilasci): nessun chip.
      return null;
  }
};

/** L'id dell'oggetto che l'indirizzo nomina col codice: task, automazioni e supporto (area 10, F1). */
export const contextIdOf: typeof Fake.contextIdOf = async (kind, code) => {
  if (kind === "automation") return (await visibleAutomation({ code }))?.id ?? null;
  if (kind === "support") {
    const c = await visibleSupport(code);
    if (!c) return null;
    codeOfObjectFor().set(c.id, c.code);
    return c.id;
  }
  if (kind !== "task") return null;
  const task = await getTaskByCode(code);
  if (!task) return null;
  codeOfObjectFor().set(task.id, task.code);
  return task.id;
};

const stateOf = (state: View["state"]): Conversation["state"] =>
  state === "working" || state === "queued" ? "working" : state === "ended" ? "finished" : "idle";

/** Le conversazioni libere lette, PER PERSONA: `sendMessage` le riconosce (contesto, budget). */
const freeByPerson = new Map<string, Set<string>>();
function freeIdsFor(): Set<string> {
  const me = session.personId ?? "";
  let ids = freeByPerson.get(me);
  if (!ids) freeByPerson.set(me, (ids = new Set()));
  return ids;
}
export const isFreeConversation = (id: string): boolean => freeIdsFor().has(id);

/** Cambio di persona o test: via le memorie della chat. */
export function forgetChatCaches(): void {
  codesByPerson.clear();
  freeByPerson.clear();
}

export function toConversation(v: View): Conversation {
  freeIdsFor().add(v.id);
  const published = v.publishedProjects.map((p) => p.id);
  const held = v.heldProjects.map((p) => p.id);
  return {
    id: v.id,
    kind: "free",
    title: v.title,
    // L'autore dal server (fetta 5); da un server più vecchio la conversazione
    // è privata, quindi di chi guarda.
    ownerId: v.author?.id ?? (v.isOwner ? (session.personId ?? "") : ""),
    projectId: null,
    contextProjectId: contextProjectOf(v.context),
    taskId: null,
    requestId: null,
    state: stateOf(v.state),
    outcome: null,
    visibility: v.visibility === "public" ? "public" : "private",
    publishedAt: v.publishedAt,
    publishedById: v.publishedBy?.id ?? null,
    // I nomi del server: per chi guarda una conversazione d'altri, anche fuori dai suoi progetti.
    ...(v.isOwner ? {} : { ownerName: v.author?.name ?? null }),
    ...(v.publishedBy ? { publishedByName: v.publishedBy.name } : {}),
    // I progetti che chi guarda vede: quelli confermati e, per l'autore, i
    // NUOVI del seguito privato (da riconfermare).
    touchedProjectIds: [...published, ...held.filter((id) => !published.includes(id))],
    // Il server non dà l'indice: la pagina guarda solo se c'è un seguito
    // privato da riconfermare (l'autore, `heldProjects`).
    privateFromIndex: v.isOwner && held.length > 0 ? 0 : null,
    publishedProjectIds: published,
    continuesFromId: v.continuesFrom?.id ?? null,
    createdAt: v.createdAt,
    updatedAt: v.lastEventAt && v.lastEventAt > v.updatedAt ? v.lastEventAt : v.updatedAt,
    archived: v.archived,
  };
}

export function toFreeRow(v: View): ConversationRow {
  const c = toConversation(v);
  return {
    ...c,
    objectCode: null,
    activity: c.state === "working" ? { kind: "action", label: "" } : null,
    privateTail: !v.isOwner && v.privateTail,
    waitsOnViewer: false,
  };
}

/** Le proprie, attive o archiviate, dalla più recente. */
/** Quante pagine dell'elenco si leggono al più (100 conversazioni l'una). */
const MINE_PAGES = 5;

export async function listMine(archived: boolean): Promise<ConversationRow[]> {
  return listScope("mine", archived);
}

/** Le pubbliche di altri (fetta 5): le dà il server, con `claude.public.view`. */
export async function listPublic(): Promise<ConversationRow[]> {
  return listScope("public", false);
}

async function listScope(scope: "mine" | "public", archived: boolean): Promise<ConversationRow[]> {
  const rows: ConversationRow[] = [];
  let before: string | undefined;
  for (let page = 0; page < MINE_PAGES; page++) {
    const list = await appClient().claude.conversations.list({
      scope,
      archived,
      limit: 100,
      ...(before ? { before } : {}),
    });
    rows.push(...list.items.map(toFreeRow));
    if (!list.nextCursor) break;
    before = list.nextCursor;
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export const createConversation: typeof Fake.createConversation = async (input = {}) => {
  // Il contesto di un rilascio (area 8) non è integrato: resta il progetto, se c'è.
  const projectId = input.contextProjectId ?? null;
  const created = await call(() =>
    appClient().claude.conversations.create(projectId ? { context: { kind: "project", id: projectId } } : {}),
  );
  return toConversation(created);
};

export const renameConversation: typeof Fake.renameConversation = async (id, title) => {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("invalid: title");
  return toConversation(await call(() => appClient().claude.conversations.update(id, { title: trimmed })));
};

export const archiveConversation: typeof Fake.archiveConversation = async (id, archived = true) =>
  toConversation(await call(() => appClient().claude.conversations.update(id, { archived })));

export const deleteConversation: typeof Fake.deleteConversation = async (id) => {
  await call(() => appClient().claude.conversations.remove(id));
};

/**
 * «Make public» / «Make private» (fetta 5, solo l'autore). La prima
 * pubblicazione risponde 409 `needs_confirmation` coi progetti letti o
 * toccati (alla riconferma di un seguito privato, solo i nuovi) e se la
 * conversazione ha letture dei tool: il dialogo lo dice.
 */
export const setVisibility: typeof Fake.setVisibility = async (id, visibility, options = {}) => {
  try {
    const view = await appClient().claude.conversations.setVisibility(id, {
      visibility,
      ...(options.confirmedProjectIds ? { confirmedProjectIds: options.confirmedProjectIds } : {}),
    });
    return { status: "done", conversation: toConversation(view) };
  } catch (error) {
    if (error instanceof ApiError && error.code === "needs_confirmation") {
      const confirmation = claudeVisibilityConfirmationSchema.safeParse(error.details);
      if (confirmation.success) {
        return {
          status: "needs_confirmation",
          touchedProjects: confirmation.data.projects.map((p) => ({ id: p.id, code: p.code, name: p.name })),
          includesToolReads: confirmation.data.includesToolReads,
          reconfirm: confirmation.data.reconfirm,
        };
      }
    }
    // Review di F1: Claude ha letto contenuti privati, la conversazione resta privata.
    if (error instanceof ApiError && error.code === "private_content") return { status: "private_content" };
    if (error instanceof ApiError && error.status === 403) throw new Error("forbidden");
    return call(() => Promise.reject(error));
  }
};

/**
 * «Continue» (fetta 5): una pubblica di un altro diventa una conversazione
 * NUOVA, privata, di chi chiama; Claude da lì legge e propone come lui.
 */
export const continueConversation: typeof Fake.continueConversation = async (publicId) => {
  try {
    return toConversation(await appClient().claude.conversations.continue(publicId));
  } catch (error) {
    // La propria, o una che non si continua (privata nel frattempo, archiviata).
    if (error instanceof ApiError && error.status === 409 && error.code !== "budget_exhausted")
      throw new Error("invalid: not_public");
    return call(() => Promise.reject(error));
  }
};

export const setConversationContext: typeof Fake.setConversationContext = async (id, projectId) => {
  await call(() =>
    appClient().claude.conversations.update(id, { context: projectId ? { kind: "project", id: projectId } : null }),
  );
};

/**
 * Un messaggio nella conversazione. Col contesto della pagina (il chip del
 * riquadro) il contesto salvato si aggiorna PRIMA del messaggio, così il
 * turno lo legge; il server lo ripete al modello a ogni turno (`tipo: id`).
 */
export async function sendFreeMessage(id: string, text: string, context: ContextRef | null): Promise<void> {
  const serverContext = context ? await serverContextOf(context) : null;
  if (serverContext) await call(() => appClient().claude.conversations.update(id, { context: serverContext }));
  await call(() => appClient().agentSessions.send(id, { text }));
}

/** Il budget del mese (la sola cosa del blocco d'istanza che la chat legge). */
export async function chatAiBlock(projectId: string | null): Promise<AiBlock | null> {
  const status = await appClient().claude.status();
  // Il budget del mese vince sugli avvii, ovunque.
  if (status.budgetExhausted) return { reason: "monthly_budget" };
  if (projectId === null) return null;
  // Area 9, F4: la coda del progetto in pausa, dalla vista del progetto
  // (72, 5713037b2), con il nome calcolato dal server.
  let project: { queuePause?: { byId: string | null; byName: string; since: string } | null };
  try {
    project = await appClient().projects.get(projectId);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
  const pause = project.queuePause ?? null;
  return pause
    ? { reason: "queue_paused", byId: pause.byId ?? "", byName: pause.byName, since: pause.since }
    : null;
}

// --- «/», «#», «@» e i codici nei testi -------------------------------------------

/**
 * I comandi di «/», nell'ordine del prototipo (`STUBWISE_COMMANDS`): solo
 * quelli che i tool coprono davvero. `/status` e `/today` dall'area 10 (F8:
 * `read_followed_projects` e `read_my_week`; il comando scrive solo il testo,
 * è il modello a chiamare i tool), quelli d'azione con `claude-chat-actions`.
 * Le descrizioni nella lingua di chi guarda.
 */
const COMMANDS = ["status", "today", "explain", "plan", "new-task", "new-request", "run", "docs"] as const;
/** Fetta 3: i comandi d'azione, che diventano una proposta (Claude propone, il server esegue). */
const ACTION_COMMANDS = new Set<string>(["plan", "new-task", "new-request", "run"]);

/**
 * Poi le skill che entrano nei run del progetto di contesto (area 10, F8, su
 * `GET /api/projects/:id/plugins`): i plugin pronti e accesi sul progetto,
 * meno le skill spente, col `name` del manifest come namespace. Il server non
 * dà le descrizioni delle skill, né il plugin base (sta fuori dal registro).
 * Un progetto che chi guarda non vede: solo i comandi di Stubwise.
 */
export const listCommands: typeof Fake.listCommands = async (contextProjectId) => {
  const actions = featureIntegrated("claude-chat-actions");
  const stubwise = COMMANDS.filter((id) => actions || !ACTION_COMMANDS.has(id)).map<SlashCommand>((id) => ({
    id: `cmd-${id}`,
    label: `/${id}`,
    description: i18n.t(`claude.conversation.commands.${id}`),
    source: "stubwise",
  }));
  return [...stubwise, ...(contextProjectId ? await pluginSkillCommands(contextProjectId) : [])];
};

async function pluginSkillCommands(projectId: string): Promise<SlashCommand[]> {
  let view: Awaited<ReturnType<ReturnType<typeof appClient>["projects"]["plugins"]>>;
  try {
    view = await appClient().projects.plugins(projectId);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return [];
    throw error;
  }
  const choices = new Map(view.plugins.map((c) => [c.pluginId, c] as const));
  return view.registry.flatMap((r) => {
    const choice = choices.get(r.pluginId);
    if (r.status !== "ready" || !choice?.enabled) return [];
    return r.skills
      .filter((skill) => !choice.disabledSkills.includes(skill))
      .map<SlashCommand>((skill) => ({
        id: `${r.name}:${skill}`,
        label: `/${r.name}:${skill}`,
        description: "",
        source: { plugin: r.name, skill },
      }));
  });
}

const MENTION_LIMIT = 8;

/**
 * «#»: task, progetti, pagine Docs e file del Drive che chi guarda vede (il server filtra);
 * «@»: le persone. Dall'area 10 (F8) anche le richieste, per codice e
 * titolo, dei progetti che chi guarda vede (`GET /api/requests?projectId=…`,
 * filtrato dal server); una fusa no, come nel prototipo.
 */
export const searchMentions: typeof Fake.searchMentions = async (q, kind) => {
  const needle = q.trim().toLowerCase();
  const has = (...fields: (string | null | undefined)[]) =>
    !needle || fields.some((f) => f?.toLowerCase().includes(needle));
  if (kind === "people") {
    const people = await listPeople();
    return people
      .filter((p) => !p.isClaude && has(p.name))
      .slice(0, MENTION_LIMIT)
      .map<MentionResult>((p) => ({ ref: { kind: "person", id: p.id }, code: null, label: p.name, detail: null, projectId: null }));
  }
  const projectsRead = listProjects();
  const [projects, tasks, docHits, driveRows, requests] = await Promise.all([
    projectsRead,
    needle ? listTasks({ text: q.trim(), families: ["todo", "active"] }) : Promise.resolve([]),
    needle && featureIntegrated("docs") ? docMentionHits(q.trim()) : Promise.resolve([]),
    needle && featureIntegrated("drive") ? drive.searchDrive(q.trim()).then((r) => r.files.map((h) => h.file)) : Promise.resolve([]),
    needle ? projectsRead.then((list) => requestsOf(list.map((p) => p.id))) : Promise.resolve([]),
  ]);
  const nameOf = new Map(projects.map((p) => [p.id, p.name] as const));
  const projectRows = projects
    .filter((p) => has(p.code, p.name))
    .map<MentionResult>((p) => ({ ref: { kind: "project", id: p.id }, code: p.code, label: p.name, detail: null, projectId: p.id }));
  const taskRows = tasks.map<MentionResult>((t) => ({
    ref: { kind: "task", id: t.id },
    code: t.code,
    label: t.title,
    detail: nameOf.get(t.projectId) ?? null,
    projectId: t.projectId,
  }));
  const requestRows = requests
    .filter((r) => r.mergedIntoId === null && has(r.code, r.title))
    .map<MentionResult>((r) => ({
      ref: { kind: "request", id: r.id },
      code: r.code,
      label: r.title,
      detail: nameOf.get(r.projectId) ?? null,
      projectId: r.projectId,
    }));
  // Una pagina si cita col suo codice (`AUD-D3`): il progetto è il prefisso.
  const byCode = new Map(projects.map((p) => [p.code, p] as const));
  const docRows = docHits.flatMap<MentionResult>((d) => {
    const project = byCode.get(DOC_CODE_RE.exec(d.code)?.[1] ?? "");
    if (!project) return [];
    return [{ ref: { kind: "doc", id: d.code }, code: d.code, label: d.title, detail: `${project.code} · ${d.repositoryName}`, projectId: project.id }];
  });
  // I file del Drive dei progetti di cui si è membri, per nome e codice. Il
  // riferimento porta il codice (R-H5): resta anche se il file se ne va.
  const driveMentions = driveRows.map<MentionResult>((f) => ({
    ref: { kind: "drive", id: f.id, code: f.code },
    code: f.code,
    label: f.name,
    detail: f.projectCode || null,
    projectId: f.projectId,
    drive: { type: f.type, google: false },
  }));
  return [
    ...[...taskRows, ...projectRows].slice(0, MENTION_LIMIT),
    ...requestRows.slice(0, MENTION_LIMIT),
    ...docRows.slice(0, MENTION_LIMIT),
    ...driveMentions.slice(0, MENTION_LIMIT),
  ];
};

/**
 * Le richieste dei progetti dati, per «#». Un progetto la cui lettura fallisce
 * (backlog spento, permesso tolto nel frattempo) non dà righe e non toglie le
 * altre.
 */
async function requestsOf(projectIds: string[]): Promise<ProjectRequestSummary[]> {
  const lists = await Promise.all(
    projectIds.map((id) =>
      appClient()
        .requests.list(id)
        .then((rows) => rows as ProjectRequestSummary[])
        .catch(() => []),
    ),
  );
  return lists.flat();
}

/**
 * Le pagine Docs per «#»: la ricerca globale con `citable` (niente note di
 * rilascio). Un server che non conosce il parametro le manda comunque, e senza
 * codice: si tengono solo le pagine che ne hanno uno.
 */
async function docMentionHits(q: string): Promise<(SearchDocHit & { code: string })[]> {
  const hits = await appClient().search.global(q, undefined, { citable: true });
  return hits.docs.items.filter((d): d is SearchDocHit & { code: string } => d.code !== null && d.kind !== "releases");
}

const hidden = (ref: CitationRef): CitationView => ({
  kind: ref.kind,
  id: ref.id,
  visible: false,
  code: null,
  name: null,
  projectCode: null,
  status: null,
  personId: null,
  route: null,
});

const TASK_CODE = /^[A-Z][A-Z0-9]*-\d+$/;
const REQUEST_CODE = /^[A-Z][A-Z0-9]*-R\d+$/;

/**
 * Una pagina Docs dal suo codice (area 5, fetta 1): dove sta (`GET
 * /api/docs/codes/:code`, 404 per un codice che non c'è o che non si vede) e
 * il suo titolo. Una pagina tolta (`available` falso) non torna.
 */
async function docByCode(code: string, codesOf: Map<string, string>): Promise<CitationView | null> {
  try {
    const where = await appClient().request("GET", `/api/docs/codes/${encodeURIComponent(code)}`, undefined, docCodeResolutionSchema);
    const project = codesOf.get(where.projectId);
    if (!where.available || !project) return null;
    const page = await appClient().docs.page(where.repositoryId, where.slug);
    return {
      ...hidden({ kind: "doc", id: where.code }),
      visible: true,
      code: where.code,
      name: page.title,
      projectCode: project,
      route: `#/p/${project}/docs/${where.repositorySlug}/${where.slug}`,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * I codici scritti nel testo (di Claude o di chi scrive) che chi guarda VEDE:
 * task e richieste, letti col server. Uno nascosto e uno inesistente non
 * tornano, nello stesso modo (404 in entrambi i casi).
 */
export const resolveCodes: typeof Fake.resolveCodes = async (codes) => {
  const unique = [...new Set(codes.map((c) => c.toUpperCase()))];
  const codesOf = new Map((await listProjects()).map((p) => [p.id, p.code] as const));
  const views = await Promise.all(
    unique.map(async (code): Promise<CitationView | null> => {
      if (DOC_CODE_RE.test(code)) return docByCode(code, codesOf);
      if (REQUEST_CODE.test(code)) {
        const r = await getRequestByCode(code).catch(() => null);
        const project = r ? codesOf.get(r.projectId) : undefined;
        if (!r || !project) return null;
        return {
          ...hidden({ kind: "request", id: r.id }),
          visible: true,
          code: r.code,
          name: r.title,
          projectCode: project,
          status: r.status,
          personId: r.requesterIds[0] ?? null,
          route: `#/p/${project}/requests?request=${r.id}`,
        };
      }
      if (TASK_CODE.test(code)) {
        const t = await getTaskByCode(code).catch(() => null);
        const project = t ? codesOf.get(t.projectId) : undefined;
        if (!t || !project) return null;
        return {
          ...hidden({ kind: "task", id: t.id }),
          visible: true,
          code: t.code,
          name: t.title,
          projectCode: project,
          status: null,
          personId: t.assigneeId,
          route: `#/p/${project}/tasks?task=${t.code}`,
        };
      }
      return null;
    }),
  );
  return views.filter((v): v is CitationView => v !== null);
};

/**
 * Le citazioni registrate su un messaggio. Quelle della Chat (area 4, F2.7)
 * le ha già confermate il server, filtrate per chi guarda: si risolvono da lì.
 * Le altre (una risposta di Claude non ne registra: cita col codice nel testo,
 * che `resolveCodes` legge) si leggono come non visibili, senza nome — mai un
 * titolo che il server non ha confermato.
 */
export const resolveCitations: typeof Fake.resolveCitations = async (refs) => {
  if (refs.length === 0) return [];
  const codes = new Map((await listProjects()).map((p) => [p.id, p.code] as const));
  return refs.map((ref) => chatCitationView(ref, (id) => codes.get(id)) ?? hidden(ref));
};

// --- il dettaglio ----------------------------------------------------------------

/**
 * Il dettaglio di una conversazione libera, coi permessi che dice il server:
 * scrivere e fermare (`canWrite`, `canInterrupt`), gestire (rinomina,
 * archivia, elimina: è dell'autore, l'unico che la vede). Archiviata non si
 * scrive. Nessuna pubblica, nessun «Continua».
 */
export function freeDetailOf(
  v: Reader<ClaudeConversationDetailView>,
  events: ConversationDetail["events"],
): ConversationDetail {
  const row = toFreeRow(v);
  // Fetta 5: chi legge una pubblica di un altro la legge e basta (la
  // continua); da un server più vecchio `isOwner` vale true.
  const owner = v.isOwner;
  return {
    ...row,
    isOwner: owner,
    canWrite: owner && v.session.canWrite && !v.archived,
    canInterrupt: owner && v.session.canInterrupt && !v.archived,
    // Area 10, F2: le domande a scelta le risponde l'autore (il server lo
    // riverifica: 403 a chiunque altro); archiviata non si risponde.
    canAnswer: owner && !v.archived,
    canDecidePlan: false,
    canRejectPlan: false,
    canPreApprovePlan: false,
    canRevokePlanApproval: false,
    planPreApproved: false,
    canContinue: !owner && v.canContinue,
    canManage: owner,
    canPublish: owner && v.canPublish,
    canClose: false,
    canStartNew: false,
    readOnlyReason: !owner
      ? "not_owner"
      : v.archived
        ? "archived"
        : v.session.canWrite
          ? null
          : "not_interactive",
    planBlockedReason: null,
    events,
    continuesFrom: null,
  };
}
