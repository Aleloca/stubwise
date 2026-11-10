import { ApiError } from "@stubwise/api-client";
import { claudeVisibilityConfirmationSchema } from "@stubwise/shared";
import type {
  ClaudeConversation,
  ClaudeConversationContext,
  ClaudeConversationDetail as ClaudeConversationDetailView,
  Reader,
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
import { listProjects } from "./projects";
import { getRequest, getRequestByCode } from "./requests";
import { getTaskByCode, listTasks } from "./tasks";
import { featureIntegrated } from "../../integration";

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

/**
 * Il contesto di una pagina come lo legge il server: `tipo: id`, dove l'id è
 * ciò con cui il modello lo rilegge coi suoi tool — il CODICE di una task o di
 * una richiesta (`read_task`, `read_request`), l'id di un progetto. Gli
 * oggetti delle aree non integrate (rilasci, supporto, PR, automazioni,
 * posta) non danno contesto.
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
    default:
      // Le aree non integrate: nessun chip.
      return null;
  }
};

/** L'id dell'oggetto che l'indirizzo nomina col codice: solo le task (le altre aree non sono integrate). */
export const contextIdOf: typeof Fake.contextIdOf = async (kind, code) => {
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
  if (projectId !== null) return null;
  const status = await appClient().claude.status();
  return status.budgetExhausted ? { reason: "monthly_budget" } : null;
}

// --- «/», «#», «@» e i codici nei testi -------------------------------------------

/**
 * I comandi di «/» di questa fetta: solo quelli che i tool di lettura coprono
 * davvero (`read_task`/`read_request` per `/explain`, `search_docs` per
 * `/docs`). `/status` e `/today` del prototipo leggono progetti seguiti,
 * decisioni e la settimana di chi scrive, che i tool non vedono: tornano con
 * la fetta che li copre. Le skill dei plugin non ci sono (il server non le
 * espone). Le descrizioni nella lingua di chi guarda.
 */
const READ_COMMANDS = ["explain", "docs"] as const;
/** Fetta 3: i comandi d'azione, che diventano una proposta (Claude propone, il server esegue). */
const ACTION_COMMANDS = ["plan", "new-task", "new-request", "run"] as const;

export const listCommands: typeof Fake.listCommands = async () =>
  [...READ_COMMANDS, ...(featureIntegrated("claude-chat-actions") ? ACTION_COMMANDS : [])].map<SlashCommand>((id) => ({
    id: `cmd-${id}`,
    label: `/${id}`,
    description: i18n.t(`claude.conversation.commands.${id}`),
    source: "stubwise",
  }));

const MENTION_LIMIT = 8;

/**
 * «#»: task e progetti che chi guarda vede (il server filtra); «@»: le
 * persone. Le richieste e le pagine Docs non ci sono ancora (limite della
 * fetta, nel registro dei rimandi).
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
  const [projects, tasks] = await Promise.all([
    listProjects(),
    needle ? listTasks({ text: q.trim(), families: ["todo", "active"] }) : Promise.resolve([]),
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
  return [...taskRows, ...projectRows].slice(0, MENTION_LIMIT);
};

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
 * I codici scritti nel testo (di Claude o di chi scrive) che chi guarda VEDE:
 * task e richieste, letti col server. Uno nascosto e uno inesistente non
 * tornano, nello stesso modo (404 in entrambi i casi).
 */
export const resolveCodes: typeof Fake.resolveCodes = async (codes) => {
  const unique = [...new Set(codes.map((c) => c.toUpperCase()))];
  const codesOf = new Map((await listProjects()).map((p) => [p.id, p.code] as const));
  const views = await Promise.all(
    unique.map(async (code): Promise<CitationView | null> => {
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
 * Le citazioni registrate su un messaggio: sul server una risposta di Claude
 * non ne registra (cita col codice nel testo, che `resolveCodes` legge).
 * Arrivano quindi solo da un client che le conosce: si leggono come non
 * visibili, senza nome — mai un titolo che il server non ha confermato.
 */
export const resolveCitations: typeof Fake.resolveCitations = async (refs) => refs.map(hidden);

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
    canAnswer: false,
    canDecidePlan: false,
    canRejectPlan: false,
    canPreApprovePlan: false,
    canRevokePlanApproval: false,
    planPreApproved: false,
    canContinue: !owner && v.canContinue,
    canManage: owner,
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
