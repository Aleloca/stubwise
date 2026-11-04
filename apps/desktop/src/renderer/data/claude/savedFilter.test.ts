import { beforeEach, describe, expect, it } from "vitest";
import {
  claude,
  createConversation,
  getConversation,
  resetApi,
  runScript,
  sendMessage,
  setLatency,
  setStreamLatency,
  settlePageEvent,
  updateFilter,
} from "../api";
import { applyActions } from "../api-mutations";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { ConversationEvent, ProposedAction } from "../types";
import { CLAUDE_CATALOG } from "./catalog";
import { classOfGroup } from "./classes";

// Il filtro salvato personale dal riquadro di Claude (area 10b, Task 9): è
// una scrittura dei dati, quindi una voce del catalogo. Nasce privato, è
// classe A (tocca solo chi chiede), «Annulla» lo elimina — finché la
// persona non l'ha cambiato dopo. Il «Who?» non c'è: un filtro personale
// non chiede permessi (P4). E `settlePageEvent`, l'unica scrittura degli
// eventi del riquadro: solo chi ha aperto la conversazione.

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const MARCO = "p-marco";
const ACQ = "prj-acq";

const as = (personId: string) => setSessionPersonId(personId);
const eventsOf = (id: string): ConversationEvent[] => state.conversationEvents.get(id) ?? [];
type Executed = Extract<ConversationEvent, { type: "executed" }>;
type PageEvent = Extract<ConversationEvent, { type: "pageAction" }>;

const CRITERIA = { projectIds: [ACQ], assigneeIds: [MARCO], families: ["todo", "active"] };
const saveArgs = (extra: Record<string, unknown> = {}) => ({
  name: "Marco in ACQ",
  criteria: CRITERIA,
  view: "list",
  groupBy: "status",
  ...extra,
});
const action = (fn: ProposedAction["fn"], args: Record<string, unknown>): ProposedAction => ({
  fn,
  args,
  summary: fn,
});

beforeEach(() => {
  setLatency(0);
  setStreamLatency(null);
  resetApi();
});

describe("saveFilter e deleteFilter nel catalogo", () => {
  it("saveFilter: A, si annulla con deleteFilter, nessun «Who?»; deleteFilter: B, non si annulla", () => {
    expect(CLAUDE_CATALOG.saveFilter).toMatchObject({
      apiFn: "saveFilter",
      baseClass: "A",
      undoable: true,
      whoAction: null,
    });
    expect(CLAUDE_CATALOG.deleteFilter).toMatchObject({
      apiFn: "deleteFilter",
      baseClass: "B",
      undoable: false,
      whoAction: null,
    });
    as(LAURA);
    expect(classOfGroup(LAURA, [action("saveFilter", saveArgs())]).cls).toBe("A");
  });

  it("nasce privato e di chi chiede, coi criteri chiesti; l'inverso lo elimina", () => {
    as(LAURA);
    const done = applyActions(LAURA, [action("saveFilter", saveArgs())], { catalogOnly: true });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const saved = state.filters.find((f) => f.name === "Marco in ACQ")!;
    expect(saved).toMatchObject({ ownerId: LAURA, visibility: "private", criteria: CRITERIA });
    const run = done.catalogRuns[0]!;
    expect(run.objects).toEqual([{ kind: "filter", id: saved.id }]);
    expect(run.projectIds).toEqual([]);
    expect(run.inverse).toEqual({ fn: "deleteFilter", args: { id: saved.id } });
    const undone = applyActions(LAURA, [action("deleteFilter", run.inverse!.args)], {
      catalogOnly: true,
    });
    expect(undone.ok).toBe(true);
    expect(state.filters.some((f) => f.id === saved.id)).toBe(false);
  });

  it('con `visibility: "public"` è `invalid`, e non nasce niente', () => {
    as(LAURA);
    const before = state.filters.length;
    const done = applyActions(LAURA, [action("saveFilter", saveArgs({ visibility: "public" }))], {
      catalogOnly: true,
    });
    expect(done).toMatchObject({ ok: false, code: "invalid" });
    expect(() => CLAUDE_CATALOG.saveFilter.run(LAURA, saveArgs({ visibility: "public" }))).toThrow(
      "invalid: visibility",
    );
    expect(state.filters.length).toBe(before);
  });

  it("senza nome o con criteri che non sono criteri: `invalid`", () => {
    as(LAURA);
    expect(() => CLAUDE_CATALOG.saveFilter.run(LAURA, saveArgs({ name: "  " }))).toThrow("invalid");
    expect(() => CLAUDE_CATALOG.saveFilter.run(LAURA, saveArgs({ criteria: "acq" }))).toThrow(
      "invalid: criteria",
    );
  });
});

describe("«Annulla» del filtro salvato da Claude", () => {
  /** Laura chiede le task di Marco in ACQ, la pagina le filtra, poi salva il filtro. */
  async function savedByClaude(): Promise<{ cid: string; groupId: string; filterId: string }> {
    as(LAURA);
    const cid = (await createConversation()).id;
    await sendMessage(cid, { text: "mostrami le task di Marco in ACQ" });
    const page = eventsOf(cid).find((e): e is PageEvent => e.type === "pageAction")!;
    expect(page.status).toBe("pending");
    // La pagina sotto l'ha eseguito (il riquadro): «questo filtro» c'è.
    await settlePageEvent(cid, page.id, "done");
    await sendMessage(cid, { text: "salva questo filtro come Marco in ACQ" });
    const row = eventsOf(cid).find((e): e is Executed => e.type === "executed")!;
    expect(row).toMatchObject({ status: "done" });
    expect(row.actions[0]).toMatchObject({ fn: "saveFilter" });
    const filter = state.filters.find((f) => f.name === "Marco in ACQ")!;
    expect(filter).toMatchObject({
      ownerId: LAURA,
      visibility: "private",
      criteria: { projectIds: [ACQ], assigneeIds: [MARCO], families: ["todo", "active"] },
    });
    return { cid, groupId: row.groupId, filterId: filter.id };
  }

  it("«salva questo filtro come …» dopo il filtro salva quei criteri; «Annulla» lo elimina", async () => {
    const { cid, groupId, filterId } = await savedByClaude();
    expect((await getConversation(cid))!.undo?.[groupId]).toEqual({
      state: "available",
      needsReauth: false,
    });
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({ ok: true });
    expect(state.filters.some((f) => f.id === filterId)).toBe(false);
  });

  it("dopo un `updateFilter` della persona, «Annulla» è `changed_after` e il filtro resta", async () => {
    const { cid, groupId, filterId } = await savedByClaude();
    await updateFilter(filterId, { name: "Marco · ACQ" });
    expect((await getConversation(cid))!.undo?.[groupId]).toMatchObject({
      state: "changed_after",
    });
    expect(await claude.undoClaudeActions(cid, groupId)).toMatchObject({
      ok: false,
      error: "changed_after",
    });
    expect(state.filters.some((f) => f.id === filterId)).toBe(true);
  });

  it("senza un filtro fatto prima, una riga chiede di filtrare e non nasce niente", async () => {
    as(LAURA);
    const before = state.filters.length;
    const cid = (await createConversation()).id;
    await sendMessage(cid, { text: "salva questo filtro come Marco in ACQ" });
    expect(eventsOf(cid).some((e) => e.type === "executed" || e.type === "proposal")).toBe(false);
    expect(state.filters.length).toBe(before);
    // Un filtro ancora `pending` (la pagina non l'ha eseguito) non vale.
    await sendMessage(cid, { text: "show ACQ tasks assigned to Marco" });
    await sendMessage(cid, { text: "save this filter as Marco in ACQ" });
    expect(eventsOf(cid).some((e) => e.type === "executed")).toBe(false);
    expect(state.filters.length).toBe(before);
  });
});

describe("settlePageEvent", () => {
  async function pending(): Promise<{ cid: string; eventId: string }> {
    as(ROBERTA);
    const cid = (await createConversation()).id;
    await runScript(cid, [
      {
        step: "event",
        event: { type: "pageAction", action: { kind: "theme", to: "dark" }, status: "pending" },
      },
    ]);
    const event = eventsOf(cid).find((e) => e.type === "pageAction")!;
    return { cid, eventId: event.id };
  }
  const statusOf = (cid: string) =>
    (eventsOf(cid).find((e) => e.type === "pageAction") as PageEvent).status;

  it("chi ha aperto la conversazione chiude l'evento: `done`, poi `undone`", async () => {
    const { cid, eventId } = await pending();
    await settlePageEvent(cid, eventId, "done");
    expect(statusOf(cid)).toBe("done");
    await settlePageEvent(cid, eventId, "undone");
    expect(statusOf(cid)).toBe("undone");
  });

  it("da un'altra persona: `forbidden`, anche su una pubblica, e l'evento resta com'era", async () => {
    const { cid, eventId } = await pending();
    state.conversations.find((c) => c.id === cid)!.visibility = "public";
    as(LAURA);
    await expect(settlePageEvent(cid, eventId, "done")).rejects.toThrow("forbidden");
    expect(statusOf(cid)).toBe("pending");
  });

  it("un evento chiuso non si riapre, e uno stato d'un altro tipo d'evento non vale", async () => {
    const { cid, eventId } = await pending();
    await expect(settlePageEvent(cid, eventId, "placed")).rejects.toThrow("invalid");
    await settlePageEvent(cid, eventId, "done");
    await settlePageEvent(cid, eventId, "changed_after");
    await expect(settlePageEvent(cid, eventId, "undone")).rejects.toThrow("invalid");
    expect(statusOf(cid)).toBe("changed_after");
  });

  it("un evento che non è del riquadro: `not_found`", async () => {
    as(ROBERTA);
    const cid = (await createConversation()).id;
    await runScript(cid, [{ step: "say", text: "hi" }]);
    const said = eventsOf(cid)[0]!;
    await expect(settlePageEvent(cid, said.id, "done")).rejects.toThrow("not_found");
  });
});
