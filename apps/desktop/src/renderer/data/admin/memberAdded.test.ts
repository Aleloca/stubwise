import { beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  claude,
  confirmProposal,
  createConversation,
  createProject,
  getConversation,
  listNotifications,
  mail,
  resetApi,
  runScript,
  setLatency,
  setStreamLatency,
} from "../api";
import { markReauthenticated, REAUTH_GRACE_MINUTES } from "../auth/reauth";
import type { ProposedAction } from "../model";
import { CLAUDE_ID } from "../seed/people";
import { setSessionPersonId } from "../session";
import { advanceNow, state, visibleProjectIds } from "../store";
import type { AppNotification, ConversationEvent } from "../types";
import { memberAddedRecipientOf } from "./members";

// `member.added` (area 10b, Task 7, D4): chi viene aggiunto a un progetto lo
// sa — a mano (Members), da Claude per conto di qualcuno (col segno) e da
// una proposta della posta confermata (P25). Non parte per chi aggiunge sé
// stesso né per Claude collega (P8: provato sulla regola, non su scenari che
// `judgeJoin` rifiuta prima), né per un cambio di ruolo. Il nome del ruolo si
// legge a lettura; dopo un «Annulla» la notifica resta, con «Undone by».

const LAURA = "p-laura";
const LUCA = "p-luca";
const MARCO = "p-marco";
const ROBERTA = "p-roberta";
const ACQ = "prj-acq";
const DEVELOPER = "role-developer";

const as = (personId: string) => setSessionPersonId(personId);
const eventsOf = (id: string): ConversationEvent[] => state.conversationEvents.get(id) ?? [];
type Proposal = Extract<ConversationEvent, { type: "proposal" }>;

beforeEach(() => {
  setLatency(0);
  setStreamLatency(null);
  resetApi();
});

async function addedOf(personId: string): Promise<AppNotification[]> {
  as(personId);
  return (await listNotifications()).filter((n) => n.kind === "member.added");
}

describe("memberAddedRecipientOf", () => {
  it("la persona aggiunta; mai chi agisce, mai Claude collega (P8)", () => {
    expect(memberAddedRecipientOf(LAURA, LUCA)).toBe(LUCA);
    expect(memberAddedRecipientOf(LAURA, LAURA)).toBeNull();
    expect(memberAddedRecipientOf(LAURA, CLAUDE_ID)).toBeNull();
  });
});

describe("member.added a mano", () => {
  it("Laura aggiunge Luca da Members: Luca la riceve, senza segno, coi valori stabili", async () => {
    expect(await addedOf(LUCA)).toEqual([]);
    as(LAURA);
    markReauthenticated(LAURA);
    expect(await admin.addMember(ACQ, LUCA, DEVELOPER)).toEqual({ ok: true });
    const [n, ...rest] = await addedOf(LUCA);
    expect(rest).toEqual([]);
    expect(n).toMatchObject({
      kind: "member.added",
      projectId: ACQ,
      objectCode: "ACQ",
      roleId: DEVELOPER,
      roleName: "Developer",
      actorName: "Laura Costa",
      link: "#/p/ACQ/overview",
      read: false,
    });
    expect(n!.viaClaude).toBeUndefined();
    expect(n!.notOpenable).toBeUndefined();
    // Chi aggiunge non riceve niente.
    expect(await addedOf(LAURA)).toEqual([]);
  });

  it("cambiare il ruolo non è un'aggiunta: nessuna notifica nuova", async () => {
    as(LAURA);
    markReauthenticated(LAURA);
    await admin.addMember(ACQ, LUCA, DEVELOPER);
    const before = state.notifications.length;
    expect(await admin.setMemberRole(ACQ, LUCA, "role-viewer")).toEqual({ ok: true });
    expect(state.notifications).toHaveLength(before);
    expect(await addedOf(LUCA)).toHaveLength(1);
  });

  it("il nome del ruolo si legge a lettura: rinominato dopo, la notifica dice il nome nuovo", async () => {
    as(LAURA);
    markReauthenticated(LAURA);
    await admin.addMember(ACQ, LUCA, DEVELOPER);
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    expect(await admin.updateRole(DEVELOPER, { name: "Engineer" })).toEqual({ ok: true });
    expect((await addedOf(LUCA))[0]!.roleName).toBe("Engineer");
  });

  it("chi crea un progetto ne diventa Project Lead senza avvisare sé stesso", async () => {
    as(ROBERTA);
    const before = state.notifications.length;
    await createProject({ code: "NEWP", name: "New project", template: "empty" });
    expect(state.notifications).toHaveLength(before);
  });
});

describe("member.added dalla posta (P25)", () => {
  it("Matteo conferma una proposta che aggiunge Chiara ad AUD: Chiara la riceve senza segno, Matteo no", async () => {
    as("p-matteo");
    markReauthenticated("p-matteo");
    const out = await mail.confirmMailProposal("mp-aud-weekly-review", {
      addOutsiders: ["p-chiara"],
    });
    expect(out.status).toBe("confirmed");
    const [n, ...rest] = await addedOf("p-chiara");
    expect(rest).toEqual([]);
    expect(n).toMatchObject({ projectId: "prj-aud", objectCode: "AUD", roleName: "Contributor" });
    expect(n!.viaClaude).toBeUndefined();
    expect(await addedOf("p-matteo")).toEqual([]);
  });
});

/** Una scheda di `personId` confermata nel riquadro: la conversazione e il gruppo. */
async function confirmed(personId: string, actions: ProposedAction[]) {
  as(personId);
  markReauthenticated(personId);
  const cid = (await createConversation()).id;
  await runScript(cid, [
    {
      step: "event",
      event: {
        type: "proposal",
        proposalId: "prop-test",
        requesterId: personId,
        actions,
        status: "open",
      },
    },
  ]);
  expect(await confirmProposal(cid, "prop-test")).toMatchObject({ status: "confirmed" });
  const p = eventsOf(cid).find((e): e is Proposal => e.type === "proposal")!;
  return { cid, groupId: p.groupId! };
}

const addLuca: ProposedAction = {
  fn: "addMember",
  args: { projectId: ACQ, personId: LUCA, roleId: DEVELOPER },
  summary: "Add Luca Bianchi to ACQ as Developer",
};

describe("member.added da Claude per conto di Laura", () => {
  it("col segno; «Annulla» a grazia scaduta chiede il codice; annullata, resta una sola notifica, «Undone by Laura Costa», e non si apre più", async () => {
    const { cid, groupId } = await confirmed(LAURA, [addLuca]);
    expect(visibleProjectIds(LUCA).has(ACQ)).toBe(true);
    const [n] = await addedOf(LUCA);
    expect(n!.viaClaude).toMatchObject({ personId: LAURA });
    expect(n!.viaClaudeName).toBe("Laura Costa");
    expect(n!.undoneByName).toBeNull();

    as(LAURA);
    advanceNow((REAUTH_GRACE_MINUTES + 1) * 60_000);
    expect((await getConversation(cid))!.undo?.[groupId]).toEqual({
      state: "available",
      needsReauth: true,
    });
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({
      ok: false,
      error: "reauth_required",
    });
    markReauthenticated(LAURA);
    // L'inverso (removeMember) non avvisa: «Annulla» parte subito.
    expect(await claude.undoClaudeActions(cid, groupId)).toEqual({ ok: true });
    expect(visibleProjectIds(LUCA).has(ACQ)).toBe(false);

    // Luca non vede più ACQ, ma la notifica che parla di lui resta [SC 16]:
    // una sola, con «Undone by», e il progetto non si apre più.
    const after = await addedOf(LUCA);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(n!.id);
    expect(after[0]!.undoneByName).toBe("Laura Costa");
    expect(after[0]!.notOpenable).toBe(true);
  });

  it("l'«Annulla» di un `removeMember` di Claude (inverso `addMember`) avvisa: apre una scheda (P7)", async () => {
    const { cid, groupId } = await confirmed(LAURA, [
      {
        fn: "removeMember",
        args: { projectId: ACQ, personId: MARCO },
        summary: "Remove Marco Bellini from ACQ",
      },
    ]);
    expect(visibleProjectIds(MARCO).has(ACQ)).toBe(false);
    as(LAURA);
    const result = await claude.undoClaudeActions(cid, groupId);
    expect(result).toMatchObject({ ok: true, proposalId: expect.any(String) });
    const card = eventsOf(cid).find(
      (e): e is Proposal => e.type === "proposal" && e.undoOf === groupId,
    )!;
    expect(card.reasons).toEqual([
      { kind: "notifies", personIds: [MARCO], more: false },
      { kind: "reauth" },
    ]);
    // Niente prima della conferma.
    expect(visibleProjectIds(MARCO).has(ACQ)).toBe(false);
    expect(await addedOf(MARCO)).toEqual([]);
    as(LAURA);
    expect(await confirmProposal(cid, card.proposalId)).toMatchObject({ status: "confirmed" });
    expect(visibleProjectIds(MARCO).has(ACQ)).toBe(true);
    // La scheda diceva «Notifies Marco Bellini»: l'avviso esce.
    expect(await addedOf(MARCO)).toHaveLength(1);
  });
});
