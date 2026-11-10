import { z } from "zod";

/**
 * L'attività del giorno di una persona (integrazione area 3, fetta 3d: lo
 * standup), nella forma `PersonDayActivity` del prototipo. Aggregata sul
 * SERVER (decisione del maintainer), solo dei progetti che chi guarda vede, e
 * solo per chi ha `people.activity.view`.
 */
const taskRef = { taskId: z.uuid(), code: z.string(), title: z.string(), projectId: z.uuid(), at: z.iso.datetime() };

export const personDayActivitySchema = z.object({
  /** `null`: un autore di commit non collegato a nessuna persona (la mail non è di un utente). */
  personId: z.uuid().nullable(),
  name: z.string(),
  departmentIds: z.array(z.uuid()).default([]),
  tasksClosed: z.array(z.object(taskRef)).default([]),
  tasksMoved: z
    .array(
      z.object({
        ...taskRef,
        field: z.string(),
        from: z.string().nullable(),
        to: z.string().nullable(),
        viaClaude: z.boolean().default(false),
      }),
    )
    .default([]),
  /** Il server non tiene le task eliminate: oggi sempre vuoto. */
  tasksDeleted: z.array(z.object({ ...taskRef, viaClaude: z.boolean().default(false) })).default([]),
  comments: z
    .array(
      z.object({
        id: z.uuid(),
        taskId: z.uuid(),
        code: z.string(),
        projectId: z.uuid(),
        body: z.string(),
        at: z.iso.datetime(),
        viaClaude: z.boolean().default(false),
      }),
    )
    .default([]),
  decisions: z
    .array(
      z.object({
        id: z.uuid(),
        /** `log`: il registro decisioni; `answer`: la risposta a una richiesta di decisione fra persone. */
        source: z.enum(["log", "answer"]),
        projectId: z.uuid(),
        taskId: z.uuid().nullable(),
        title: z.string(),
        at: z.iso.datetime(),
      }),
    )
    .default([]),
  requestsCreated: z
    .array(z.object({ requestId: z.uuid(), code: z.string(), title: z.string(), projectId: z.uuid(), at: z.iso.datetime() }))
    .default([]),
  commits: z
    .array(
      z.object({
        sha: z.string(),
        repo: z.string(),
        authorId: z.uuid().nullable(),
        authorName: z.string(),
        message: z.string(),
        /** Testo generato (`commit_summaries.summary`): la UI lo etichetta come tale. */
        aiSummary: z.string(),
        at: z.iso.datetime(),
        projectId: z.uuid(),
      }),
    )
    .default([]),
});
export type PersonDayActivityView = z.infer<typeof personDayActivitySchema>;

/** `GET /api/people/activity?date=YYYY-MM-DD&departmentId=`: il giorno nel fuso Europe/Rome. */
export const peopleActivityQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departmentId: z.uuid().optional(),
});
