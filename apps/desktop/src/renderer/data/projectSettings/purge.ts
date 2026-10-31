import { visitSteps } from "../../domain/automations/fields";
import { forgetSecret } from "../admin/secrets";
import { writeAccess } from "../access/index";
import type { Project } from "../model";
import { now, reindex, state } from "../store";

// Cosa toglie l'eliminazione di un progetto (area 9c, Task 5): ogni riga
// del progetto, in ogni parte dello stato. Restano solo:
// - il registro: le voci di progetto non si leggono più (il progetto non
//   esiste), `project.deleted` sì (R-G5, `changelog/reads.ts`);
// - `deletedProjects`, perché quella voce e la provenienza di un repository
//   senza progetto si risolvano a lettura;
// - i repository, senza progetto (`detachedRepositories`, maintainer, 31
//   ott 2026): tengono nome, URL, account git, comandi, grafo e rami
//   protetti; perdono file d'ambiente, pagine dei Docs, PR e rilasci; il
//   webhook torna da configurare e il suo secret si dimentica (puntava al
//   progetto eliminato: scelta del controller);
// - i server: senza gli ambienti del progetto, e chi resta senza ambienti è
//   orfano (R-L7);
// - i consumi (`instance.usage`): il mese li ha spesi, e il budget li conta
//   ancora. Si leggono in «Other projects», come quelli di un progetto che
//   non si vede (scelta del controller);
// Nelle righe che restano il progetto si toglie anche dove è annidato: un
// invito in sospeso perde il progetto che prometteva; il passo «progetto
// fisso» di un'automazione (generale) resta senza progetto (`projectId: ""`,
// col segno `unavailable` che il costruttore dice «A project that's no longer
// available»), quindi è un errore di configurazione («Manca il progetto») e,
// se gira, il passo non si fa con la ragione del progetto non più
// disponibile, come su un archiviato ([PX 5], Task 6).
// Tutti i segreti del progetto (valori d'ambiente, secret dei webhook, chiave
// d'ingestione) si tolgono dal caveau.
//
// I figli si tolgono per riferimento (task, conversazioni, canali, file del
// Drive, automazioni, repository, ambienti): una riga che punta a un figlio
// tolto se ne va con lui.

/** Le tabelle che `purgeProject` non filtra per riga: le tratta a parte, o restano. */
const KEPT = new Set([
  "changelog",
  "deletedProjects",
  "detachedRepositories",
  "projects",
  "repositories",
  // Gli eventi del calendario di una persona restano suoi: perdono solo il progetto.
  "calendarEvents",
  "calendarSeries",
]);

/** Gli indici per id dei figli tolti: una riga che punta a uno di loro se ne va. */
const CHILD_KEYS = [
  "taskId",
  "requestId",
  "conversationId",
  "channelId",
  "automationId",
  "repositoryId",
  "environmentId",
  "fileId",
] as const;
type ChildKey = (typeof CHILD_KEYS)[number];

type Row = Record<string, unknown>;
const isRow = (x: unknown): x is Row => typeof x === "object" && x !== null;

/** Toglie le righe che appartengono al progetto o a un figlio tolto. */
function dropRows(id: string, gone: Record<ChildKey, Set<string>>): void {
  const belongs = (row: unknown) =>
    isRow(row) &&
    (row.projectId === id ||
      CHILD_KEYS.some((k) => typeof row[k] === "string" && gone[k].has(row[k] as string)));
  const s = state as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(s))
    if (!KEPT.has(key) && Array.isArray(value)) s[key] = value.filter((row) => !belongs(row));
}

/** Una mappa per chiave composta (`persona\0id`): toglie le chiavi che finiscono con un id tolto. */
function dropComposite<V>(map: Map<string, V> | Set<string>, ids: Set<string>): void {
  for (const key of [...map.keys()]) {
    const tail = key.slice(key.lastIndexOf("\u0000") + 1);
    if (ids.has(tail)) map.delete(key);
  }
}

/**
 * Toglie il progetto da ogni parte dello stato (vedi sopra) e lo ricorda in
 * `deletedProjects`. Restituisce quanti repository restano senza progetto.
 * Chi chiama ha già fatto i controlli e scrive la voce.
 */
export function purgeProject(project: Project, me: string): number {
  const id = project.id;
  const at = now();
  const ids = <T extends Row>(rows: T[], keep: (row: T) => boolean) =>
    new Set(rows.filter(keep).map((r) => r.id as string));

  const repos = state.repositories.filter((r) => r.projectId === id);
  const gone: Record<ChildKey, Set<string>> = {
    taskId: ids(state.tasks as unknown as Row[], (t) => t.projectId === id),
    requestId: ids(state.requests as unknown as Row[], (r) => r.projectId === id),
    conversationId: new Set(),
    channelId: ids(state.channels as unknown as Row[], (c) => c.projectId === id),
    automationId: ids(state.automations as unknown as Row[], (a) => a.projectId === id),
    repositoryId: new Set(repos.map((r) => r.id)),
    environmentId: ids(state.environments as unknown as Row[], (e) => e.projectId === id),
    fileId: ids(state.driveFiles as unknown as Row[], (f) => f.projectId === id),
  };
  gone.conversationId = new Set(
    state.conversations
      .filter(
        (c) =>
          c.projectId === id ||
          (c.taskId !== null && gone.taskId.has(c.taskId)) ||
          (c.requestId !== null && gone.requestId.has(c.requestId)),
      )
      .map((c) => c.id),
  );
  const runIds = new Set(
    state.automationRuns.filter((r) => gone.automationId.has(r.automationId)).map((r) => r.id),
  );
  const messageIds = new Set(
    state.chatMessages.filter((m) => gone.channelId.has(m.channelId)).map((m) => m.id),
  );
  const notificationIds = new Set(
    state.notifications.filter((n) => n.projectId === id).map((n) => n.id),
  );

  // I segreti, prima che spariscano le righe che li nominano.
  for (const f of state.envFiles)
    if (gone.repositoryId.has(f.repositoryId) || gone.environmentId.has(f.environmentId))
      for (const v of f.vars) if (v.secretId) forgetSecret(v.secretId);
  for (const r of repos) if (r.webhook?.secretId) forgetSecret(r.webhook.secretId);
  const settings = state.projectSettings.get(id);
  if (settings?.ingestion.secretId) forgetSecret(settings.ingestion.secretId);

  // I repository restano, senza progetto.
  for (const r of repos)
    state.detachedRepositories.push({
      repository: {
        ...r,
        projectId: "",
        webhook: { state: "not_configured", configuredAt: null, secretId: null, last4: null },
      },
      formerProjectId: id,
      detachedAt: at,
      detachedById: me,
    });
  state.repositories = state.repositories.filter((r) => r.projectId !== id);

  // Le righe del progetto e dei suoi figli, in ogni tabella.
  dropRows(id, gone);
  state.automationRuns = state.automationRuns.filter((r) => !runIds.has(r.id));

  // I riferimenti al progetto nelle righe che restano.
  for (const c of state.conversations) {
    c.touchedProjectIds = c.touchedProjectIds.filter((p) => p !== id);
    c.publishedProjectIds = c.publishedProjectIds.filter((p) => p !== id);
    if (c.contextProjectId === id) c.contextProjectId = null;
  }
  for (const r of state.automationRuns) {
    r.projectIds = r.projectIds.filter((p) => p !== id);
    for (const [client, projectId] of Object.entries(r.projects ?? {}))
      if (projectId === id) delete r.projects![client];
  }
  for (const invite of state.invites)
    invite.projects = invite.projects.filter((p) => p.projectId !== id);
  for (const a of state.automations)
    for (const v of a.versions)
      visitSteps(v.flow.steps, (step) => {
        const target = (
          step as { project?: { mode: string; projectId?: string; unavailable?: true } }
        ).project;
        if (target?.mode === "fixed" && target.projectId === id) {
          // Senza id, e col segno che il costruttore legge ([PX 5]).
          target.projectId = "";
          target.unavailable = true;
        }
      });
  for (const f of state.filters)
    if (f.criteria.projectIds)
      f.criteria.projectIds = f.criteria.projectIds.filter((p) => p !== id);
  for (const m of [...state.mailMessages, ...state.mailIncoming]) {
    const c = m.classification;
    if (c.state !== "done") continue;
    c.projectIds = c.projectIds.filter((p) => p !== id);
    c.uncertainProjectIds = c.uncertainProjectIds.filter((p) => p !== id);
  }
  for (const e of [...state.calendarEvents, ...state.calendarSeries])
    if (e.projectId === id) e.projectId = null;
  for (const s of state.servers) if (s.primaryProjectId === id) s.primaryProjectId = null;
  for (const [person, pinned] of state.pinned)
    state.pinned.set(
      person,
      pinned.filter((p) => p !== id),
    );
  for (const [code, projects] of state.serverTombstones)
    state.serverTombstones.set(
      code,
      projects.filter((p) => p !== id),
    );

  // Le mappe per progetto e per figlio tolto.
  for (const map of [
    state.projectSettings,
    state.docCodeSeq,
    state.driveCodeSeq,
    state.automationCodeSeq,
    state.releaseCodeSeq,
    state.supportCodeSeq,
  ])
    map.delete(id);
  for (const c of gone.conversationId) {
    state.conversationEvents.delete(c);
    state.preApprovedPlans.delete(c);
    state.sendingTo.delete(c);
  }
  for (const r of runIds) state.automationClock.delete(r);
  for (const f of gone.fileId) {
    state.driveHidden.delete(f);
    state.driveContentLog.delete(f);
  }
  for (const r of gone.repositoryId) state.docGenerationLog.delete(r);
  dropComposite(state.chatReads, gone.channelId);
  dropComposite(state.chatNotify, gone.channelId);
  dropComposite(state.chatDismissed, messageIds);
  dropComposite(state.notificationMarks, notificationIds);

  // L'istanza: la coda in pausa e il giro notturno del progetto.
  state.instance.queuePauses = state.instance.queuePauses.filter((p) => p.projectId !== id);
  state.instance.nightly = state.instance.nightly.filter((n) => n.projectId !== id);

  // Chi ne era membro, prima che le appartenenze se ne vadano.
  state.deletedProjects.push({
    id,
    code: project.code,
    name: project.name,
    memberIds: [...project.memberIds],
    deletedAt: at,
    deletedById: me,
  });
  writeAccess((a) => {
    a.memberships = a.memberships.filter((m) => m.projectId !== id);
    a.grants = a.grants.filter((g) => g.projectId !== id);
    a.revocations = a.revocations.filter((r) => r.projectId !== id);
  });
  state.projects = state.projects.filter((p) => p.id !== id);
  reindex();
  return repos.length;
}
