import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import * as api from "../api";
import {
  changelog,
  chat,
  convertRequest,
  createRequest,
  createTask,
  listNotifications,
  listPeopleActivity,
  listTimeline,
  planTask,
  resetApi,
  setLatency,
  setStreamLatency,
  updateTask,
} from "../api";
import { addCommentAs, applyActions, createTaskAs, reassignTask } from "../api-mutations";
import { recordChange } from "../changelog/index";
import type { AppNotification, ChatMessage, ConversationEvent, Task } from "../model";
import { setSessionPersonId } from "../session";
import { now, state } from "../store";
import { deleteTaskAs } from "../taskDelete";
import * as via from "./via";
import { currentVia, runAsClaude, type ViaClaude } from "./via";

// «Per conto di» nel livello dati (area 10a, Task 3). Le scritture fatte da
// Claude per una persona portano il segno: `actorId`/`authorId` restano la
// persona, `via: "claude"` lo dice. Il segno lo mette SOLO `runAsClaude`
// (in modulo, `currentVia()`); nessuna funzione pubblica lo accetta.
//
// Persone del seme: Giulia (Project Lead in OLV, dove Marco e Davide sono
// membri: ruling del controller (pre-flight), P3; Elena no, ma `updateTask`
// assegna anche fuori dai membri), Roberta (full admin),
// Laura (Project Lead in ACQ, non vede MKX).

const GIULIA = "p-giulia";
const MARCO = "p-marco";
const ELENA = "p-elena";
const DAVIDE = "p-davide";
const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const OLV = "prj-olv";
const ACQ = "prj-acq";
const MKX = "prj-mkx";

const as = (personId: string) => setSessionPersonId(personId);
const mark = (actionId = "ca-test-1", undoOfActionId: string | null = null): ViaClaude => ({
  actionId,
  undoOfActionId,
});

beforeEach(() => {
  resetApi();
  setLatency(0);
});

/** Le notifiche `kind` di una task per `personId` (destinatari fissi: kind fuori dal catalogo). */
const notesOf = (kind: string, task: Pick<Task, "code">, personId: string): AppNotification[] =>
  state.notifications.filter(
    (n) => n.kind === kind && n.objectCode === task.code && n.recipientIds.includes(personId),
  );

/** Una task di Giulia in OLV, assegnata a lei (o a `assigneeId`), senza lavoro sopra. */
const olvTask = (assigneeId: string | null = GIULIA, title = "Photos of the olive grove"): Task =>
  createTaskAs(GIULIA, { projectId: OLV, title, assigneeId });

describe("runAsClaude e currentVia", () => {
  it("il segno vale solo dentro, e torna com'era dopo (anche dopo un errore e annidato)", () => {
    expect(currentVia()).toBeNull();
    const seen = runAsClaude(mark("ca-a"), () => {
      const outer = currentVia();
      const inner = runAsClaude(mark("ca-b", "ca-a"), () => currentVia());
      return { outer, inner, after: currentVia() };
    });
    expect(seen.outer).toEqual({ actionId: "ca-a", undoOfActionId: null });
    expect(seen.inner).toEqual({ actionId: "ca-b", undoOfActionId: "ca-a" });
    expect(seen.after).toEqual({ actionId: "ca-a", undoOfActionId: null });
    expect(currentVia()).toBeNull();
    expect(() =>
      runAsClaude(mark(), () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(currentVia()).toBeNull();
  });

  it("una funzione async lancia (fn è sincrona), e il segno non resta acceso", () => {
    expect(() => runAsClaude(mark(), async () => 1)).toThrow();
    expect(currentVia()).toBeNull();
  });

  it("il modulo espone solo runAsClaude e currentVia: nessun altro scrive il segno", () => {
    expect(Object.keys(via).sort()).toEqual(["currentVia", "runAsClaude"]);
  });
});

describe("fuori da runAsClaude nessun segno", () => {
  it("voci, attività, commenti, notifiche ed eliminazioni scritte a mano non hanno il segno", () => {
    const task = olvTask(MARCO);
    reassignTask(GIULIA, task, ELENA);
    const comment = addCommentAs(GIULIA, task.id, "Looks good");
    expect(deleteTaskAs(GIULIA, olvTask(GIULIA, "Other").id)).toEqual({ ok: true });
    for (const a of state.activity) {
      expect(a.via).toBeUndefined();
      expect(a.claudeActionId).toBeUndefined();
    }
    expect(comment.via).toBeUndefined();
    for (const n of state.notifications) expect(n.viaClaude).toBeUndefined();
    for (const e of state.changelog) {
      expect(e.via).toBeUndefined();
      expect(e.claudeActionId).toBeUndefined();
      expect(e.undoOf).toBeUndefined();
    }
    for (const d of state.deletedTasks) expect(d.via).toBeUndefined();
  });
});

describe("dentro runAsClaude: la persona, col segno", () => {
  it("la voce ha actorId della persona e via; il commento authorId e via; la notifica viaClaude", () => {
    // Una task di Marco, spostata di settimana da Giulia (planning.others in OLV).
    const task = olvTask(MARCO);
    const deleting = olvTask(GIULIA, "To delete");
    runAsClaude(mark("ca-1"), () => {
      const applied = applyActions(GIULIA, [
        {
          fn: "planTask",
          args: { id: task.id, plan: { assigneeId: MARCO, week: "2026-W45" } },
          summary: "",
        },
        { fn: "addComment", args: { taskId: task.id, body: "Moved to W45" }, summary: "" },
      ]);
      expect(applied.ok).toBe(true);
      expect(deleteTaskAs(GIULIA, deleting.id)).toEqual({ ok: true });
    });

    const moved = state.activity.find((a) => a.taskId === task.id && a.field === "week")!;
    expect(moved).toMatchObject({ authorId: GIULIA, via: "claude", claudeActionId: "ca-1" });
    const comment = state.activity.find((a) => a.taskId === task.id && a.kind === "comment")!;
    expect(comment).toMatchObject({ authorId: GIULIA, via: "claude", claudeActionId: "ca-1" });

    const [planning] = notesOf("planning.changed", task, MARCO);
    expect(planning?.viaClaude).toEqual({ personId: GIULIA, actionId: "ca-1" });

    const entry = state.changelog.find((e) => e.kind === "task.deleted")!;
    expect(entry).toMatchObject({ actorId: GIULIA, via: "claude", claudeActionId: "ca-1" });
    expect(entry.undoOf).toBeUndefined();
    expect(state.deletedTasks.find((d) => d.id === deleting.id)?.via).toBe("claude");
  });

  it("l'evento task_deleted della cronologia e le righe dell'attività delle persone hanno viaClaude", async () => {
    const task = olvTask(MARCO);
    const byHand = olvTask(GIULIA, "By hand");
    const byClaude = olvTask(GIULIA, "By Claude");
    runAsClaude(mark(), () => {
      applyActions(GIULIA, [
        { fn: "planTask", args: { id: task.id, plan: { assigneeId: MARCO, week: "2026-W45" } }, summary: "" },
        { fn: "addComment", args: { taskId: task.id, body: "Via Claude" }, summary: "" },
      ]);
      deleteTaskAs(GIULIA, byClaude.id);
    });
    deleteTaskAs(GIULIA, byHand.id);
    addCommentAs(GIULIA, task.id, "By hand");

    as(GIULIA);
    const timeline = await listTimeline(OLV);
    const deleted = (id: string) =>
      timeline.find((e) => e.kind === "task_deleted" && e.taskId === id);
    expect(deleted(byClaude.id)).toMatchObject({ viaClaude: true });
    expect(deleted(byHand.id)?.kind === "task_deleted" && deleted(byHand.id)).not.toMatchObject({
      viaClaude: true,
    });

    as(ROBERTA);
    const d = new Date(now());
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const giulia = (await listPeopleActivity(day)).find((p) => p.personId === GIULIA)!;
    const row = <T extends { viaClaude: boolean }>(rows: T[], pick: (r: T) => boolean) =>
      rows.find(pick)?.viaClaude;
    expect(row(giulia.tasksMoved, (r) => r.taskId === task.id && r.field === "week")).toBe(true);
    expect(row(giulia.comments, (r) => r.body === "Via Claude")).toBe(true);
    expect(row(giulia.comments, (r) => r.body === "By hand")).toBe(false);
    expect(row(giulia.tasksDeleted, (r) => r.taskId === byClaude.id)).toBe(true);
    expect(row(giulia.tasksDeleted, (r) => r.taskId === byHand.id)).toBe(false);
  });
});

describe("nessuna API accetta il segno", () => {
  /** Un membro di un'unione è il segno: `ViaClaude` o il letterale "claude" (non `string`). */
  type IsMark<M> = 0 extends 1 & M
    ? false
    : [M] extends [ViaClaude]
      ? [ViaClaude] extends [M]
        ? true
        : false
      : [M] extends ["claude"]
        ? ["claude"] extends [M]
          ? true
          : false
        : false;
  /** `true` se almeno un membro dell'unione dei parametri è il segno. */
  type HasMark<P> = true extends (P extends unknown ? IsMark<P> : never) ? true : false;
  /** Un parametro alla volta: in un'unione `string | "claude"` il letterale sparirebbe. */
  type MarkedParam<A extends unknown[]> = true extends { [I in keyof A]: HasMark<A[I]> }[number]
    ? true
    : false;
  type Depth = [never, 0, 1, 2];
  /**
   * I nomi (anche dentro i namespace, fino a 3 livelli) delle funzioni con un
   * parametro di tipo `ViaClaude` o `"claude"`: guarda il TIPO, non il nome
   * (ruling del controller (pre-flight), P12).
   */
  type Offenders<T, D extends number = 3> = [D] extends [never]
    ? never
    : {
        [K in keyof T & string]: T[K] extends (...args: infer A) => unknown
          ? MarkedParam<A> extends true
            ? K
            : never
          : T[K] extends Record<string, unknown>
            ? Offenders<T[K], Depth[D]> extends never
              ? never
              : `${K}.${Offenders<T[K], Depth[D]>}`
            : never;
      }[keyof T & string];

  it("il controllo riconosce il segno per tipo, qualunque sia il nome del parametro", () => {
    type Probe = {
      a: (x: ViaClaude) => void;
      b: (id: string, who: "claude" | "person") => void;
      c: (id: string) => void;
      d: (fileId: string, via: "preview" | "google" | "download") => void;
      ns: { e: (mark?: ViaClaude) => void; f: (s: string) => void };
    };
    expectTypeOf<Offenders<Probe>>().toEqualTypeOf<"a" | "b" | "ns.e">();
  });

  it("nessuna funzione esportata da data/api.ts ha un parametro col segno (recordOpen non conta)", () => {
    expectTypeOf<Offenders<typeof api>>().toEqualTypeOf<never>();
    expectTypeOf<Parameters<typeof api.drive.recordOpen>[1]>().not.toEqualTypeOf<"claude">();
  });
});

describe("task.assigned (decisione del maintainer)", () => {
  it("chi riceve una task la riceve; non chi la perde, non chi se la assegna da solo", async () => {
    as(GIULIA);
    const task = await createTask({ projectId: OLV, title: "New photos", assigneeId: MARCO });
    expect(notesOf("task.assigned", task, MARCO)).toHaveLength(1);
    expect(notesOf("task.assigned", task, MARCO)[0]).toMatchObject({
      title: `You've been assigned ${task.code}`,
      projectId: OLV,
    });

    await updateTask(task.id, { assigneeId: ELENA });
    expect(notesOf("task.assigned", task, ELENA)).toHaveLength(1);
    expect(notesOf("task.assigned", task, MARCO)).toHaveLength(1);

    const before = state.notifications.filter((n) => n.kind === "task.assigned").length;
    const own = await createTask({ projectId: OLV, title: "Mine", assigneeId: GIULIA });
    await updateTask(task.id, { assigneeId: GIULIA });
    expect(notesOf("task.assigned", own, GIULIA)).toHaveLength(0);
    expect(state.notifications.filter((n) => n.kind === "task.assigned")).toHaveLength(before);
    // Togliere l'assegnatario non avvisa nessuno.
    await updateTask(task.id, { assigneeId: null });
    expect(state.notifications.filter((n) => n.kind === "task.assigned")).toHaveLength(before);

    // Marco la legge nelle sue notifiche.
    as(MARCO);
    expect((await listNotifications()).some((n) => n.kind === "task.assigned")).toBe(true);
  });

  it("una task nata dalla conversione di una richiesta avvisa chi la riceve, non chi se la dà", async () => {
    as(GIULIA);
    const toMarco = await createRequest({ projectId: OLV, title: "New harvest photos" });
    const task = await convertRequest(toMarco.id, { title: "Shoot the harvest", assigneeId: MARCO });
    expect(notesOf("task.assigned", task, MARCO)).toHaveLength(1);
    expect(notesOf("task.assigned", task, MARCO)[0]?.viaClaude).toBeUndefined();

    const before = state.notifications.filter((n) => n.kind === "task.assigned").length;
    const toSelf = await createRequest({ projectId: OLV, title: "Press kit" });
    await convertRequest(toSelf.id, { title: "Write the press kit", assigneeId: GIULIA });
    const toClaude = await createRequest({ projectId: OLV, title: "Alt texts" });
    await convertRequest(toClaude.id, { title: "Alt texts for the photos", assigneeId: "p-claude" });
    expect(state.notifications.filter((n) => n.kind === "task.assigned")).toHaveLength(before);
  });

  it("dentro runAsClaude la notifica ha viaClaude.personId della persona", () => {
    const task = olvTask(GIULIA);
    runAsClaude(mark("ca-assign"), () => {
      const applied = applyActions(GIULIA, [
        { fn: "updateTask", args: { id: task.id, patch: { assigneeId: MARCO } }, summary: "" },
      ]);
      expect(applied.ok).toBe(true);
    });
    const [note] = notesOf("task.assigned", task, MARCO);
    expect(note?.viaClaude).toEqual({ personId: GIULIA, actionId: "ca-assign" });
  });

  it("un planTask che sposta a Marco una task di Giulia gli dà una notifica sola: task.assigned", async () => {
    const task = olvTask(GIULIA);
    as(GIULIA);
    await planTask(task.id, { assigneeId: MARCO, week: "2026-W45" });
    const toMarco = state.notifications.filter(
      (n) => n.objectCode === task.code && n.recipientIds.includes(MARCO),
    );
    expect(toMarco.map((n) => n.kind)).toEqual(["task.assigned"]);
    // Chi la perde (Marco → Davide) ha ancora planning.changed; spostarla di settimana anche.
    await planTask(task.id, { assigneeId: DAVIDE, week: "2026-W45" });
    expect(notesOf("planning.changed", task, MARCO)).toHaveLength(1);
    expect(notesOf("task.assigned", task, DAVIDE)).toHaveLength(1);
    expect(notesOf("planning.changed", task, DAVIDE)).toHaveLength(0);
    await planTask(task.id, { assigneeId: DAVIDE, week: "2026-W46" });
    expect(notesOf("planning.changed", task, DAVIDE)).toHaveLength(1);
  });

  it("dentro un «Annulla» (undoOfActionId non nullo) nessuna notifica", () => {
    const task = olvTask(GIULIA);
    const before = state.notifications.length;
    runAsClaude(mark("ca-undo", "ca-done"), () => {
      reassignTask(GIULIA, task, MARCO);
      const applied = applyActions(GIULIA, [
        {
          fn: "planTask",
          args: { id: task.id, plan: { assigneeId: DAVIDE, week: "2026-W45" } },
          summary: "",
        },
      ]);
      expect(applied.ok).toBe(true);
    });
    expect(state.notifications).toHaveLength(before);
    expect(state.tasksById.get(task.id)?.assigneeId).toBe(DAVIDE);
  });
});

describe("il registro: via, undoOf e il filtro", () => {
  /** Una voce `project.renamed` scritta come la scrive un writer, sull'oggetto `id`. */
  const rename = (actorId: string, projectId: string, id = projectId) =>
    recordChange({
      kind: "project.renamed",
      actorId,
      projectId,
      object: { type: "project", id, label: "OLV" },
      before: "Old",
      after: "New",
    });

  it("dentro un «Annulla» la voce punta a quella dell'azione annullata (stesso oggetto)", () => {
    runAsClaude(mark("ca-1"), () => rename(GIULIA, OLV));
    const done = state.changelog.at(-1)!;
    runAsClaude(mark("ca-2", "ca-1"), () => rename(GIULIA, OLV));
    const undo = state.changelog.at(-1)!;
    expect(undo).toMatchObject({ via: "claude", claudeActionId: "ca-2", undoOf: done.id });
    // L'azione annullata non aveva scritto voci su quell'oggetto: undoOf resta assente.
    runAsClaude(mark("ca-3", "ca-9"), () => rename(GIULIA, OLV));
    expect(state.changelog.at(-1)!.undoOf).toBeUndefined();
    runAsClaude(mark("ca-4", "ca-1"), () => rename(GIULIA, OLV, "other-object"));
    expect(state.changelog.at(-1)!.undoOf).toBeUndefined();
  });

  it("la vista: via e undoOf solo a chi legge la voce annullata, mai claudeActionId", async () => {
    // L'azione annullata ha scritto in MKX (Laura non lo vede), l'«Annulla» in ACQ.
    runAsClaude(mark("ca-1"), () => rename(ROBERTA, MKX, "obj-shared"));
    const done = state.changelog.at(-1)!;
    runAsClaude(mark("ca-2", "ca-1"), () => rename(ROBERTA, ACQ, "obj-shared"));
    const undo = state.changelog.at(-1)!;
    expect(undo.undoOf).toBe(done.id);

    as(LAURA);
    const forLaura = (await changelog.listProjectChanges(ACQ)).find((e) => e.id === undo.id)!;
    expect(forLaura.via).toBe("claude");
    expect(forLaura.undoOf).toBeNull();
    expect("claudeActionId" in forLaura).toBe(false);

    as(ROBERTA);
    const forRoberta = (await changelog.listChanges()).find((e) => e.id === undo.id)!;
    expect(forRoberta.undoOf).toBe(done.id);
    expect("claudeActionId" in forRoberta).toBe(false);
  });

  it("listChanges({ via }) dà solo le voci col segno; personId le include; la scelta «claude»", async () => {
    as(ROBERTA);
    expect((await changelog.listChangeFilterChoices()).claude).toBe(false);
    runAsClaude(mark(), () => rename(ROBERTA, OLV));
    rename(ROBERTA, OLV);
    const marked = state.changelog.at(-2)!;

    const onlyClaude = await changelog.listChanges({ via: "claude" });
    expect(onlyClaude.map((e) => e.id)).toEqual([marked.id]);
    const byRoberta = await changelog.listChanges({ personId: ROBERTA });
    expect(byRoberta.map((e) => e.id)).toContain(marked.id);
    expect(byRoberta.find((e) => e.id === marked.id)?.actorId).toBe(ROBERTA);
    expect((await changelog.listChangeFilterChoices()).claude).toBe(true);

    // Laura non legge le voci di OLV: per lei non c'è la scelta.
    as(LAURA);
    expect((await changelog.listChanges({ via: "claude" })).map((e) => e.id)).toEqual([]);
    expect((await changelog.listChangeFilterChoices()).claude).toBe(false);
  });

  it("una voce nata prima del 10a (senza via) si legge senza segno", async () => {
    as(ROBERTA);
    const seeded = state.changelog[0]!;
    expect(seeded.via).toBeUndefined();
    const view = (await changelog.listChanges()).find((e) => e.id === seeded.id)!;
    expect(view.via).toBeUndefined();
    expect(view.undoOf).toBeNull();
  });
});

describe("@Claude nella Chat: le conferme portano il segno (maintainer)", () => {
  const proposalOf = (m: { claudeEvents?: ConversationEvent[] }) => {
    const p = m.claudeEvents?.find((e) => e.type === "proposal");
    return p?.type === "proposal" ? p : undefined;
  };

  it("planTask verso Marco confermato da Giulia in un thread di OLV: via, viaClaude, nessuna azione registrata", async () => {
    setStreamLatency(null);
    const task = olvTask(GIULIA);
    const root = state.chatMessages.find(
      (m) => m.channelId === "ch-olv-general" && m.threadOf === null,
    )!;
    const reply: ChatMessage = {
      id: "m-test-claude",
      channelId: root.channelId,
      threadOf: root.id,
      authorId: "p-claude",
      kind: "claude",
      calledById: GIULIA,
      text: "I can move it to Marco Bellini: confirm below.",
      attachments: [],
      citations: [],
      reactions: [],
      asksReplyOf: [],
      linkedCodes: [],
      createdAt: now(),
      editedAt: null,
      deletedAt: null,
      deletedById: null,
      claudeEvents: [
        {
          id: "ev-test-proposal",
          at: now(),
          type: "proposal",
          proposalId: "prop-test-plan",
          requesterId: GIULIA,
          actions: [
            {
              fn: "planTask",
              args: { id: task.id, plan: { assigneeId: MARCO, week: "2026-W45" } },
              summary: `Plan ${task.code} for Marco Bellini · W45`,
            },
          ],
          status: "open",
        },
      ],
    };
    state.chatMessages.push(reply);
    const claudeActionsBefore = JSON.stringify(
      (state as unknown as Record<string, unknown>).claudeActions ?? null,
    );

    as(GIULIA);
    const outcome = await chat.confirmChatProposal(reply.id, "prop-test-plan");
    expect(outcome).toMatchObject({ status: "confirmed" });
    expect(proposalOf(state.chatMessages.find((m) => m.id === reply.id)!)?.status).toBe(
      "confirmed",
    );
    expect(currentVia()).toBeNull();

    const assigned = state.activity.find((a) => a.taskId === task.id && a.field === "assignee")!;
    expect(assigned).toMatchObject({ authorId: GIULIA, via: "claude" });
    const [note] = notesOf("task.assigned", task, MARCO);
    expect(note?.viaClaude?.personId).toBe(GIULIA);
    expect(
      JSON.stringify((state as unknown as Record<string, unknown>).claudeActions ?? null),
    ).toBe(claudeActionsBefore);

    // Una scrittura a mano nello stesso thread, subito dopo: senza segno.
    await chat.sendMessage(root.channelId, { text: "Thanks, done.", threadOf: root.id });
    const mine = state.chatMessages.filter((m) => m.threadOf === root.id && m.authorId === GIULIA);
    expect(mine.at(-1)).not.toHaveProperty("via");
    await updateTask(task.id, { title: "Photos of the olive grove (hand)" });
    const byHand = state.activity.filter((a) => a.taskId === task.id && a.field === "title");
    expect(byHand.at(-1)?.via).toBeUndefined();
  });
});
