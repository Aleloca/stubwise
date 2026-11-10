import { ApiError } from "@stubwise/api-client";
import type * as Fake from "../../api";
import { appClient } from "./client";

// «By person» di Activity nella build app (integrazione area 3, fetta 3d): lo
// standup del giorno aggregato dal SERVER (decisione del maintainer), nel
// fuso Europe/Rome, solo dei progetti che chi guarda vede, con il permesso
// d'istanza `people.activity.view` (nel registro vero). `viaClaude` lo
// deriva il server dalle scritture (chat, fetta 3); le task eliminate vengono
// dalla lapide. Limite: i commit legati alla persona per email (gli altri
// arrivano con `personId: null` e il nome dell'autore). I report giornalieri vengono
// dalla Daily Activity Report (`GET /api/activity?date=`).

export const listPeopleActivity: typeof Fake.listPeopleActivity = async (date, departmentId) => {
  try {
    return (await appClient().people.activity(date, departmentId)).map((p) => ({
      personId: p.personId,
      name: p.name,
      ...(p.personId === null ? { authorEmail: p.authorEmail, authorUsername: p.authorUsername } : {}),
      departmentIds: p.departmentIds,
      tasksClosed: p.tasksClosed,
      tasksMoved: p.tasksMoved,
      tasksDeleted: p.tasksDeleted,
      comments: p.comments,
      decisions: p.decisions.flatMap((d) => (d.source === "__unknown__" ? [] : [{ ...d, source: d.source }])),
      requestsCreated: p.requestsCreated,
      commits: p.commits,
    }));
  } catch (error) {
    // Come il prototipo: chi non ha il permesso riceve un rifiuto, non un elenco vuoto.
    if (error instanceof ApiError && error.status === 403) throw new Error("forbidden");
    throw error;
  }
};

/**
 * «Link a person» (area 3, 3e.2): l'email git dell'autore diventa
 * un'identità della persona (`POST /api/users/:id/git-identities`,
 * `users.manage` con la riconferma), e da lì i suoi commit passano sotto di
 * lei. Senza email (un server più vecchio) non si collega: la riga non offre
 * il gesto.
 */
export const linkCommitAuthor: typeof Fake.linkCommitAuthor = async (authorName, personId, authorEmail) => {
  if (!authorEmail) throw new Error("not_found");
  try {
    await appClient().request("POST", `/api/users/${encodeURIComponent(personId)}/git-identities`, {
      email: authorEmail,
      authorName,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiError && error.code === "reauth_required") return { ok: false, error: "reauth_required" };
    if (error instanceof ApiError && error.code === "git_identity_taken") return { ok: false, error: "taken" };
    throw error;
  }
};

/**
 * I report del giorno dei progetti visibili: fatti (la sintesi) o falliti
 * (`summary: null`); quelli in coda o in scrittura `pending` (la riga dice
 * che si stanno generando). Il server non dice quando è stato scritto
 * (`generatedAt: null`), ma quanti commit sono arrivati dopo.
 */
export const listDailyReports: typeof Fake.listDailyReports = async (date) =>
  (await appClient().activity.forDate(date)).projects.flatMap((p) => {
    const base = {
      id: `${p.project.id}:${date}`,
      projectId: p.project.id,
      date,
      generatedAt: null,
      newCommits: p.staleCommitCount,
    };
    if (p.status === "done") return [{ ...base, summary: p.summary }];
    if (p.status === "failed") return [{ ...base, summary: null }];
    if (p.status === "queued" || p.status === "running") return [{ ...base, summary: null, newCommits: 0, pending: true }];
    return [];
  });

/** La generazione in corso per giorno: più progetti, una chiamata sola. */
const generating = new Map<string, Promise<unknown>>();

/**
 * «Rigenera i report»: sul server vero vale per TUTTI i progetti del giorno
 * (`POST /api/activity/generate`, `settings.manage`), non per uno come nel
 * prototipo. Più progetti chiesti insieme fanno una chiamata sola; i report
 * nascono in coda, e le letture li mostrano in scrittura finché non ci sono.
 */
export const generateDailyReport: typeof Fake.generateDailyReport = async (projectId, date) => {
  let call = generating.get(date);
  if (!call) {
    call = appClient()
      .request("POST", "/api/activity/generate", { date, force: true })
      .finally(() => generating.delete(date));
    generating.set(date, call);
  }
  await call;
  return { id: `${projectId}:${date}`, projectId, date, summary: null, generatedAt: null };
};
