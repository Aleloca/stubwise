import { ApiError } from "@stubwise/api-client";
import type * as Fake from "../../api";
import { appClient } from "./client";

// «By person» di Activity nella build app (integrazione area 3, fetta 3d): lo
// standup del giorno aggregato dal SERVER (decisione del maintainer), nel
// fuso Europe/Rome, solo dei progetti che chi guarda vede, con il permesso
// d'istanza `people.activity.view` (nel registro vero). Limiti del server:
// `tasksDeleted` sempre vuoto (le task eliminate non si tengono), `viaClaude`
// sempre falso, i commit legati alla persona per email (gli altri arrivano
// con `personId: null` e il nome dell'autore). I report giornalieri vengono
// dalla Daily Activity Report (`GET /api/activity?date=`).

export const listPeopleActivity: typeof Fake.listPeopleActivity = async (date, departmentId) => {
  try {
    return (await appClient().people.activity(date, departmentId)).map((p) => ({
      personId: p.personId,
      name: p.name,
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
 * I report del giorno dei progetti visibili: fatti (la sintesi) o falliti
 * (`summary: null`); quelli ancora in coda o in scrittura non ci sono. Il
 * server non dice quando è stato scritto (`generatedAt: null`), ma quanti
 * commit sono arrivati dopo (`staleCommitCount`).
 */
export const listDailyReports: typeof Fake.listDailyReports = async (date) =>
  (await appClient().activity.forDate(date)).projects.flatMap((p) =>
    p.status === "done" || p.status === "failed"
      ? [
          {
            id: `${p.project.id}:${date}`,
            projectId: p.project.id,
            date,
            summary: p.status === "done" ? p.summary : null,
            generatedAt: null,
            newCommits: p.staleCommitCount,
          },
        ]
      : [],
  );
