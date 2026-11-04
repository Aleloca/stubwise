import { beforeEach, describe, expect, it } from "vitest";
import {
  automations,
  claude,
  confirmProposal,
  createConversation,
  getConversation,
  projectSettings,
  resetApi,
  sendMessage,
  setLatency,
  setStreamLatency,
} from "../api";
import { INACTIVE_DAYS, lastActivityOf } from "../projectActivity";
import { setSessionPersonId } from "../session";
import { now, state, visibleProjectIds } from "../store";
import type { ConversationEvent } from "../types";
import { archiveCandidatesFor } from "./answersData";

// Le azioni in blocco di Claude (area 10b, Task 7, S4): «archivia i progetti
// senza attività da 3 mesi». I candidati li calcola il livello dati con le
// letture di chi chiede (`archiveCandidatesFor`): aperti, visibili, senza
// attività (`lastActivityOf`), divisi fra archiviabili, `busy` e non
// gestibili. La conferma è tutta o niente (`executeGroup`), e «Annulla» li
// riapre tutti.

const ROBERTA = "p-roberta";
const GIULIA = "p-giulia";
const LAURA = "p-laura";
const ORT = "prj-ort";

const as = (personId: string) => setSessionPersonId(personId);
const eventsOf = (id: string): ConversationEvent[] => state.conversationEvents.get(id) ?? [];
type Proposal = Extract<ConversationEvent, { type: "proposal" }>;
const proposalOf = (cid: string) => eventsOf(cid).find((e): e is Proposal => e.type === "proposal");
const codes = (rows: { code: string }[]) => rows.map((r) => r.code).sort();
const archived = (code: string) => !!state.projects.find((p) => p.code === code)!.archived;

beforeEach(() => {
  setLatency(0);
  setStreamLatency(null);
  resetApi();
});

describe("archiveCandidatesFor", () => {
  it("Roberta: ORT, SPZ e LNT candidati, BSC `busy` (RNC, archiviato, mai)", () => {
    const view = archiveCandidatesFor(ROBERTA, INACTIVE_DAYS);
    expect(codes(view.candidates)).toEqual(["LNT", "ORT", "SPZ"]);
    expect(view.busy.map((b) => b.code)).toEqual(["BSC"]);
    expect(view.busy[0]!.reasons).toEqual(projectSettings.busyReasonsOf("prj-bsc", ROBERTA));
    expect(view.notManageable).toBe(0);
    expect(view.notManageableCodes).toEqual([]);
    for (const c of view.candidates) {
      expect(c.lastActivity).toBe(lastActivityOf(c.projectId));
      expect(c.name).toBe(state.projectsById.get(c.projectId)!.name);
    }
  });

  it("Giulia: ORT e nient'altro dei nuovi, nessun non gestibile", () => {
    const view = archiveCandidatesFor(GIULIA, INACTIVE_DAYS);
    expect(codes(view.candidates)).toEqual(["ORT"]);
    expect(view.busy).toEqual([]);
    expect(view.notManageable).toBe(0);
  });

  it("Laura: LNT non gestibile, coi soli codici che vede", () => {
    const view = archiveCandidatesFor(LAURA, INACTIVE_DAYS);
    expect(view.candidates).toEqual([]);
    expect(view.notManageable).toBe(1);
    expect(view.notManageableCodes).toEqual(["LNT"]);
    for (const code of view.notManageableCodes)
      expect(visibleProjectIds(LAURA).has(`prj-${code.toLowerCase()}`)).toBe(true);
  });

  it("la soglia conta: a 200 giorni nessun candidato", () => {
    const view = archiveCandidatesFor(ROBERTA, 200);
    expect(view.candidates).toEqual([]);
    expect(view.busy).toEqual([]);
  });
});

/** Roberta chiede di archiviare dal riquadro: la conversazione e la scheda. */
async function asked(text = "archive projects with no activity for 90 days") {
  as(ROBERTA);
  const cid = (await createConversation()).id;
  await sendMessage(cid, { text });
  const card = proposalOf(cid)!;
  return { cid, card };
}

describe("S4 Roberta: archiviare in blocco", () => {
  it("una scheda con tre `archiveProject`, i loro `why` e la nota `busy` di BSC", async () => {
    const { card } = await asked();
    expect(card.status).toBe("open");
    expect(card.actions.map((a) => a.fn)).toEqual([
      "archiveProject",
      "archiveProject",
      "archiveProject",
    ]);
    const ids = card.actions.map((a) => a.args.projectId as string);
    expect(ids.map((id) => state.projectsById.get(id)!.code).sort()).toEqual(["LNT", "ORT", "SPZ"]);
    for (const a of card.actions) {
      expect(a.why).toEqual({
        key: "claude.answers.archive.why",
        params: { date: lastActivityOf(a.args.projectId as string)! },
      });
    }
    expect(card.notes).toEqual([
      {
        kind: "busy",
        code: "BSC",
        reasons: projectSettings.busyReasonsOf("prj-bsc", ROBERTA),
      },
    ]);
    expect(card.blocked).toBeUndefined();
  });

  it("confermata: tre voci del registro per conto di Roberta; «Annulla» li riapre tutti, e un'automazione accesa resta accesa", async () => {
    as(ROBERTA);
    const auto = await automations.createAutomation({
      name: "Su task_created in ORT",
      projectId: ORT,
      flow: {
        trigger: { kind: "stubwise", event: "task_created" },
        steps: [{ id: "w", kind: "wait", for: { days: 1 } }],
        titleTemplate: "{{task.codice}}",
      },
    });
    await automations.activate(auto.id);
    const draft = await automations.createAutomation({
      name: "Bozza in ORT",
      projectId: ORT,
      flow: {
        trigger: { kind: "stubwise", event: "task_created" },
        steps: [{ id: "w", kind: "wait", for: { days: 1 } }],
        titleTemplate: "{{task.codice}}",
      },
    });
    const statusOf = (id: string) => state.automations.find((a) => a.id === id)!.status;
    const before = { active: statusOf(auto.id), draft: statusOf(draft.id) };
    expect(before.active).toBe("active");
    expect(before.draft).not.toBe("active");

    const { cid, card } = await asked();
    const changes = state.changelog.length;
    expect(await confirmProposal(cid, card.proposalId)).toMatchObject({ status: "confirmed" });
    for (const code of ["ORT", "SPZ", "LNT"]) expect(archived(code), code).toBe(true);
    expect(archived("BSC")).toBe(false);
    const entries = state.changelog.slice(changes).filter((e) => e.kind === "project.archived");
    expect(entries).toHaveLength(3);
    for (const e of entries) expect(e).toMatchObject({ actorId: ROBERTA, via: "claude" });

    const groupId = proposalOf(cid)!.groupId!;
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({ ok: true });
    for (const code of ["ORT", "SPZ", "LNT"]) expect(archived(code), code).toBe(false);
    expect(statusOf(auto.id)).toBe(before.active);
    expect(statusOf(draft.id)).toBe(before.draft);
  });

  it("Roberta ne riapre uno a mano: «Annulla» è `changed_after` e gli altri restano archiviati", async () => {
    const { cid, card } = await asked();
    await confirmProposal(cid, card.proposalId);
    as(ROBERTA);
    expect(await projectSettings.reopenProject(ORT)).toEqual({ ok: true });
    const groupId = proposalOf(cid)!.groupId!;
    expect((await getConversation(cid))!.undo?.[groupId]).toMatchObject({
      state: "changed_after",
    });
    expect(await claude.undoClaudeActions(cid, groupId)).toMatchObject({
      ok: false,
      error: "changed_after",
    });
    expect(archived("ORT")).toBe(false);
    expect(archived("SPZ")).toBe(true);
    expect(archived("LNT")).toBe(true);
  });

  it("con 8 candidati (progetti resi inattivi nel test) la scheda ha 8 azioni", async () => {
    // Cinque progetti di Roberta senza segnali recenti: si tolgono i segnali.
    const quiet = ["prj-cbv", "prj-cal", "prj-brn", "prj-glt", "prj-vdm"];
    const old = new Date(Date.parse(now()) - 200 * 86_400_000).toISOString();
    for (const id of quiet) {
      const tasks = new Set(state.tasks.filter((t) => t.projectId === id).map((t) => t.id));
      for (const t of state.tasks) if (tasks.has(t.id)) t.createdAt = old;
      for (const a of state.activity) if (tasks.has(a.taskId)) a.at = old;
      for (const r of state.requests) if (r.projectId === id) r.createdAt = old;
      for (const d of state.decisionLog) if (d.projectId === id) d.decidedAt = old;
      for (const c of state.supportConversations)
        if (c.projectId === id) for (const m of c.messages) m.at = old;
      for (const p of state.openPrs) if (p.projectId === id) p.openedAt = old;
      for (const r of state.releases) if (r.projectId === id) r.mergedAt = old;
      // Una sessione viva lo renderebbe `busy`: qui servono archiviabili.
      for (const c of state.conversations) if (c.projectId === id) c.state = "finished";
    }
    const view = archiveCandidatesFor(ROBERTA, INACTIVE_DAYS);
    expect(view.candidates).toHaveLength(8);
    const { card } = await asked();
    expect(card.actions).toHaveLength(8);
  });
});
