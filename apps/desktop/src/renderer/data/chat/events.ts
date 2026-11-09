import { chatNow, newId, state } from "../store";
import { channelStream, runScript } from "../stream";
import type {
  ChatEventKind,
  ChatMessage,
  CitationRef,
  PullRequestEvent,
  ReleasePage,
  WeeklyBrief,
} from "../types";

// Gli eventi dei progetti nei canali: un solo aiutante, `publishChatEvent`,
// che le scritture di oggi chiamano quando succede qualcosa (traguardo
// chiuso, richiesta nuova, task chiusa, PR aperta da una sessione di lavoro)
// e che scrive un messaggio di sistema, con la scheda dell'oggetto, nei
// canali del progetto che pubblicano quell'evento. Passa da `runScript`,
// quindi dallo stesso unico punto da cui entra ogni messaggio.

/** Il testo della scheda, nella forma del seme («Task closed: …»). */
function eventText(kind: ChatEventKind, ref: CitationRef): string {
  switch (kind) {
    case "task_closed":
      return `Task closed: ${state.tasksById.get(ref.id)?.title ?? ""}`;
    case "request_new":
      return `New request: ${state.requests.find((r) => r.id === ref.id)?.title ?? ""}`;
    case "milestone_reached":
      return `Milestone reached: ${state.milestones.find((m) => m.id === ref.id)?.name ?? ""}`;
    case "brief_ready":
      return "Weekly brief ready";
    case "release_page": {
      const page = state.releasePages.find((r) => r.id === ref.id);
      return page ? `Release page: ${page.version} ${page.title}` : "Release page";
    }
    case "pr_opened":
      return "Pull request opened";
    case "pr_merged":
      return "Pull request merged";
  }
}

/**
 * Pubblica un evento del progetto: un messaggio di sistema in ogni canale
 * del progetto, non archiviato, che pubblica `kind` (e solo lì). Si risolve
 * quando i messaggi sono nel flusso.
 */
export function publishChatEvent(
  projectId: string,
  kind: ChatEventKind,
  ref: CitationRef,
  text = eventText(kind, ref),
): Promise<void> {
  const targets = state.channels.filter(
    (ch) =>
      ch.kind === "project" &&
      ch.projectId === projectId &&
      !ch.archived &&
      ch.publishedEvents.includes(kind),
  );
  return Promise.all(
    targets.map((ch) => {
      const message: ChatMessage = {
        id: newId(ch.id),
        channelId: ch.id,
        threadOf: null,
        authorId: null,
        kind: "system",
        text,
        attachments: [],
        citations: [],
        reactions: [],
        asksReplyOf: [],
        event: { kind, ref: { ...ref } },
        linkedCodes: [],
        createdAt: chatNow(),
        editedAt: null,
        deletedAt: null,
        deletedById: null,
      };
      return runScript(channelStream(ch.id), [{ step: "post", message }]);
    }),
  ).then(() => undefined);
}

// --- eventi senza una scrittura che li produca (ancora) -------------------------
//
// Le pagine di Release (area 8), i brief (li scrive il worker) e le PR sulla
// piattaforma git non hanno una scrittura nel prototipo: questi aiutanti le
// simulano (seme, test, prove a mano) e pubblicano l'evento come farebbe la
// scrittura vera.

/** Una pagina di Release nuova (finta fino all'area 8). */
export function publishReleasePage(page: ReleasePage): Promise<void> {
  state.releasePages.push(structuredClone(page));
  return publishChatEvent(page.projectId, "release_page", { kind: "release", id: page.id });
}

/** Un brief settimanale pronto. */
export function publishWeeklyBrief(brief: WeeklyBrief): Promise<void> {
  state.briefs.push(structuredClone(brief));
  return publishChatEvent(brief.projectId, "brief_ready", { kind: "brief", id: brief.id });
}

/** Un evento di una PR sulla piattaforma git (aperta o mergiata). */
export function recordPullRequestEvent(event: PullRequestEvent): Promise<void> {
  state.pullRequests.push(structuredClone(event));
  if (event.kind === "pr_closed") return Promise.resolve();
  const verb = event.kind === "pr_opened" ? "opened" : "merged";
  return publishChatEvent(
    event.projectId,
    event.kind,
    { kind: "task", id: event.taskId },
    `PR #${event.number} ${verb} on ${event.repo}`,
  );
}
