import { describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import { TODAY } from "../../../data/dates";
import type { MailMessageView, MailThreadDetail, Project, Task } from "../../../data/types";
import { draftReply, hintSentence, isLate, placeDraft, type MailDraftReads } from "./mailDraft";

const t = (key: string, options?: Record<string, unknown>) => i18n.getFixedT("en")(key, options);

const project = (id: string, code: string): Project => ({ id, code, name: code }) as Project;
const task = (over: Partial<Task>): Task => ({ dueDate: null, slipCount: 0, ...over }) as Task;
const message = (over: Partial<MailMessageView>): MailMessageView =>
  ({
    id: "m1",
    from: { name: "Monica Corsi", email: "monica@mix.example", personId: null },
    to: [{ name: "Giulia Ferri", email: "giulia@example.com", personId: "p-giulia" }],
    subject: "Re: Revised quote for the spring campaign",
    text: "Could we have the revised quote and the banner review by Thursday?",
    classification: {
      state: "done",
      projectIds: ["prj-mkx"],
      importance: "high",
      dueDate: null,
      uncertainProjectIds: [],
    },
    ...over,
  }) as MailMessageView;

const PAST = "2026-10-01";

function reads(over: Partial<MailDraftReads> = {}): MailDraftReads {
  const thread: MailThreadDetail = { threadId: "th", subject: "s", messages: [message({})] };
  return {
    thread: async (id) => (id === "th" ? thread : null),
    projects: async () => [project("prj-mkx", "MKX")],
    openTasks: async (projectId) =>
      projectId === "prj-mkx"
        ? [
            task({ id: "t91", code: "MKX-91", title: "Banner review", dueDate: PAST }),
            task({ id: "t96", code: "MKX-96", title: "Send the revised quote" }),
            task({ id: "t97", code: "MKX-97", title: "Office party playlist" }),
          ]
        : [],
    ...over,
  };
}

const ctx = (read = reads()) => ({ personId: "p-giulia", personName: "Giulia Ferri", read, t });

describe("draftReply", () => {
  it("dall'ultimo messaggio, dal progetto e dall'indicazione; cita le task usate", async () => {
    const draft = await draftReply(
      { threadId: "th", hint: "tell them it slips to Thursday" },
      ctx(),
    );
    expect(draft.projectId).toBe("prj-mkx");
    expect(draft.text.split("\n")[0]).toBe("Hi Monica,");
    expect(draft.text).toContain("Revised quote for the spring campaign");
    expect(draft.text).toContain("It slips to Thursday.");
    expect(draft.text).toContain("“Banner review” is running late");
    expect(draft.text).toContain("“Send the revised quote”");
    expect(draft.text).not.toContain("playlist");
    expect(draft.text.endsWith("Best,\nGiulia Ferri")).toBe(true);
    expect(draft.used).toEqual([
      { taskId: "t91", code: "MKX-91", title: "Banner review", late: true },
      { taskId: "t96", code: "MKX-96", title: "Send the revised quote", late: false },
    ]);
  });

  it("cita solo ciò che le letture le danno: un progetto non visibile non entra", async () => {
    const draft = await draftReply(
      { threadId: "th", hint: "" },
      ctx(reads({ projects: async () => [] })),
    );
    expect(draft.projectId).toBeNull();
    expect(draft.used).toEqual([]);
    expect(draft.text).not.toContain("Banner");
    await expect(
      draftReply(
        { threadId: null, hint: "hello", projectId: "prj-mkx" },
        ctx(reads({ projects: async () => [] })),
      ),
    ).rejects.toThrow("not_found");
  });

  it("una conversazione che non vedo è not_found; un'email nuova vuole l'indicazione", async () => {
    await expect(draftReply({ threadId: "other", hint: "" }, ctx())).rejects.toThrow("not_found");
    await expect(draftReply({ threadId: null, hint: "  " }, ctx())).rejects.toThrow(
      "invalid: hint",
    );
    const fresh = await draftReply({ threadId: null, hint: "the kick-off moves to Monday" }, ctx());
    expect(fresh.text.split("\n")[0]).toBe("Hi,");
    expect(fresh.projectId).toBeNull();
  });

  it("in italiano, con le virgolette italiane", async () => {
    const it_ = (key: string, options?: Record<string, unknown>) =>
      i18n.getFixedT("it")(key, options);
    const draft = await draftReply(
      { threadId: "th", hint: "digli che arriva giovedì" },
      { ...ctx(), t: it_ },
    );
    expect(draft.text).toContain("Ciao Monica,");
    expect(draft.text).toContain("Arriva giovedì.");
    expect(draft.text).toContain("«Banner review» è in ritardo");
  });
});

describe("quante task cita", () => {
  it("in ritardo: la pertinente prima, poi il taglio a 2; aperte pertinenti al massimo 2", async () => {
    const tasks = [
      task({ id: "a", code: "MKX-1", title: "Archive old invoices", dueDate: PAST }),
      task({ id: "b", code: "MKX-2", title: "Update the logo files", slipCount: 2 }),
      task({ id: "c", code: "MKX-3", title: "Banner review", dueDate: PAST }),
      task({ id: "d", code: "MKX-4", title: "Revised quote layout" }),
      task({ id: "e", code: "MKX-5", title: "Quote numbering" }),
      task({ id: "f", code: "MKX-6", title: "Spring campaign quote approval" }),
    ];
    const draft = await draftReply(
      { threadId: "th", hint: "" },
      ctx(reads({ openTasks: async () => tasks })),
    );
    // In ritardo: c (pertinente: «banner», «review») prima, poi a (ordine di codice); b fuori.
    expect(draft.used.filter((u) => u.late).map((u) => u.taskId)).toEqual(["c", "a"]);
    // Aperte pertinenti: tre lo sarebbero, ne entrano due (ordine di codice).
    expect(draft.used.filter((u) => !u.late).map((u) => u.taskId)).toEqual(["d", "e"]);
    expect(draft.text).not.toContain("logo");
    expect(draft.text).not.toContain("Spring campaign quote approval");
  });
});

describe("pezzi", () => {
  it("hintSentence toglie il comando e chiude la frase", () => {
    expect(hintSentence("tell them that it slips to Thursday")).toBe("It slips to Thursday.");
    expect(hintSentence("dille che va bene!")).toBe("Va bene!");
    expect(hintSentence("  ")).toBe("");
  });

  it("isLate: scadenza passata o già slittata", () => {
    expect(isLate(task({ dueDate: PAST }))).toBe(true);
    expect(isLate(task({ dueDate: TODAY }))).toBe(false);
    expect(isLate(task({ slipCount: 1 }))).toBe(true);
  });

  it("placeDraft: «Sostituisci» o «Aggiungi sotto», mai in silenzio sul mio testo", () => {
    expect(placeDraft("My text.", "Claude.", "replace")).toBe("Claude.");
    expect(placeDraft("My text.\n", "Claude.", "below")).toBe("My text.\n\nClaude.");
    expect(placeDraft("", "Claude.", "below")).toBe("Claude.");
  });
});
