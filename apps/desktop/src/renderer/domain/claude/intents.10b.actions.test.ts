import i18n from "i18next";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { readsAs } from "../../data/api-mutations";
import { accessState } from "../../data/access/index";
import { createPerson } from "../../data/auth/register";
import { classOfGroup } from "../../data/claude/classes";
import { lastActivityOf } from "../../data/projectActivity";
import { isAppRoute } from "../../data/routes";
import { PEOPLE } from "../../data/seed/people";
import { setSessionPersonId } from "../../data/session";
import { now, state, visibleProjectIds } from "../../data/store";
import type { ConversationEvent, ScriptStep } from "../../data/types";
import { can, revokeProjectPermission, viewerFor } from "../../data/viewer";
import { nameList } from "../names";
import { recognize, respond, type IntentContext } from "./intents";

// Le azioni in blocco e i membri dal riquadro (area 10b, Task 7: S4, S5).
// Il motore legge con le letture di chi chiede e propone: una scheda B con
// un `archiveProject` per candidato, una scheda C con `addMember`; mai una
// scrittura. L'invisibile non esiste (R-G5, test in minuscolo), e il link
// d'invito — un segreto — non compare mai.

const en = i18n.getFixedT("en");
const it_ = i18n.getFixedT("it");
const ROBERTA = "p-roberta";
const GIULIA = "p-giulia";
const LAURA = "p-laura";
const LUCA = "p-luca";
const ACQ = "prj-acq";
const DEVELOPER = "role-developer";

function as(personId: string, t = en, extra: Partial<IntentContext> = {}): IntentContext {
  setSessionPersonId(personId);
  return {
    personId,
    contextProjectId: null,
    read: readsAs(personId),
    t,
    seed: "conv-10b-actions",
    classify: async (actions) => classOfGroup(personId, actions),
    asks: true,
    ...extra,
  };
}

const said = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "say" ? [s.text] : [])).join("\n");
type Draft<T extends ConversationEvent["type"]> = Omit<
  Extract<ConversationEvent, { type: T }>,
  "id" | "at"
>;
function events<T extends ConversationEvent["type"]>(steps: ScriptStep[], type: T): Draft<T>[] {
  return steps.flatMap((s) =>
    s.step === "event" && s.event.type === type ? [s.event as unknown as Draft<T>] : [],
  );
}
const proposalOf = (steps: ScriptStep[]) => events(steps, "proposal")[0];
const questionOf = (steps: ScriptStep[]) => events(steps, "question")[0];
const projectId = (code: string) => state.projects.find((p) => p.code === code)!.id;

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});

describe("recognize: archiviare e aggiungere un membro (P10)", () => {
  it("prima dei comandi: mai `create`", () => {
    for (const text of [
      "add Luca to ACQ as Developer",
      "aggiungi Luca ad ACQ come Developer",
      "invita Luca come Developer in ACQ",
      "invite Luca as Developer in ACQ",
      "Can you add Luca Bianchi to ACQ as Developer?",
    ])
      expect(recognize(text), text).toBe("member");
    for (const text of [
      "archive projects with no activity for 90 days",
      "archivia i progetti senza attività da 3 mesi",
      "archivia i progetti fermi",
      "please archive the inactive projects",
    ])
      expect(recognize(text), text).toBe("archive");
  });

  it("una domanda «come si fa» resta `howto` (ruling T6 I1), in en e in it", () => {
    for (const text of [
      "how do I archive a project?",
      "how can I archive inactive projects?",
      "come si archiviano i progetti fermi?",
      "how do I add a member to a project?",
      "come si aggiunge un membro?",
      "come faccio ad aggiungere Luca come Developer?",
    ])
      expect(recognize(text), text).toBe("howto");
  });

  it("una task resta una task", () => {
    expect(recognize("create “Banner copy review” in AUD")).toBe("create");
    expect(recognize("add “Banner copy review” to AUD")).toBe("create");
  });
});

describe("S4: archiviare in blocco", () => {
  it("Roberta: la prima riga col numero, una scheda B con tre azioni e i loro `why`, la nota `busy` di BSC", async () => {
    const steps = await respond("archive projects with no activity for 90 days", as(ROBERTA));
    expect(said(steps).split("\n")[0]).toBe("3 projects have had no activity for 90 days:");
    const card = proposalOf(steps)!;
    expect(card.actions.map((a) => a.fn)).toEqual(Array(3).fill("archiveProject"));
    expect(card.actions.map((a) => a.summary).sort()).toEqual(
      ["LNT", "ORT", "SPZ"].map((c) => `Archive ${c} ${state.projectsById.get(projectId(c))!.name}`),
    );
    for (const a of card.actions) {
      const date = lastActivityOf(a.args.projectId as string)!;
      expect(a.why).toEqual({ key: "claude.answers.archive.why", params: { date } });
    }
    expect(card.notes).toEqual([
      { kind: "busy", code: "BSC", reasons: api.projectSettings.busyReasonsOf("prj-bsc", ROBERTA) },
    ]);
    // Le azioni sono B: la scheda, mai un'esecuzione subito.
    expect(events(steps, "executed")).toEqual([]);
    expect(classOfGroup(ROBERTA, card.actions).cls).toBe("B");
  });

  it("in it, chiesto in mesi: «3 progetti sono senza attività da 3 mesi:»", async () => {
    const steps = await respond("archivia i progetti senza attività da 3 mesi", as(ROBERTA, it_));
    expect(said(steps).split("\n")[0]).toBe("3 progetti sono senza attività da 3 mesi:");
    expect(proposalOf(steps)!.actions).toHaveLength(3);
  });

  it("Giulia: solo ORT, e nessuna parola o numero sui progetti che non vede (R-G5)", async () => {
    const steps = await respond("archive projects with no activity for 3 months", as(GIULIA));
    expect(said(steps).split("\n")[0]).toBe("ORT has had no activity for 3 months:");
    const card = proposalOf(steps)!;
    expect(card.actions.map((a) => a.args.projectId)).toEqual(["prj-ort"]);
    expect(card.notes).toBeUndefined();
    const all = JSON.stringify(steps).toLowerCase();
    for (const code of ["spz", "lnt", "bsc"]) {
      expect(all).not.toMatch(new RegExp(`(^|[^a-z])${code}([^a-z]|$)`));
      expect(all).not.toContain(state.projectsById.get(`prj-${code}`)!.name.toLowerCase());
    }
    // Nessun numero che li conti: la lettura ne ha trovato uno.
    const read = steps.find((s) => s.step === "action")!;
    expect(read).toMatchObject({ result: "1 project" });
    expect(said(steps).replace("3 months", "")).not.toMatch(/\d/);
  });

  it("Laura, nessun candidato: una riga, e il non gestibile come riga col «Who?» del suo progetto (Q1 a)", async () => {
    const steps = await respond("archive projects with no activity for 3 months", as(LAURA));
    expect(proposalOf(steps)).toBeUndefined();
    expect(said(steps)).toBe(
      [
        "No project you manage has been inactive for 3 months.",
        "",
        "1 inactive project you can't archive · [Who?](who:manageProjectSettings/LNT)",
      ].join("\n"),
    );
  });

  it("la nota `not_manageable` di una scheda porta `codes` coi soli codici visibili, lunga quanto `count`", async () => {
    // Un progetto che Laura gestisce, reso inattivo: ora c'è una scheda, e LNT diventa la sua nota.
    const mine = state.projects.find(
      (p) =>
        visibleProjectIds(LAURA).has(p.id) &&
        !p.archived &&
        can(viewerFor(LAURA), "project.settings.manage", p.id) &&
        api.projectSettings.busyReasonsOf(p.id).length === 0,
    )!;
    quiet(mine.id);
    const steps = await respond("archive projects with no activity for 3 months", as(LAURA));
    const card = proposalOf(steps)!;
    expect(card.actions.map((a) => a.args.projectId)).toEqual([mine.id]);
    expect(card.notes).toEqual([
      { kind: "not_manageable", count: 1, whoAction: "manageProjectSettings", codes: ["LNT"] },
    ]);
  });

  it("dopo un'archiviazione la domanda successiva lo sa", async () => {
    setSessionPersonId(ROBERTA);
    state.projectsById.get("prj-ort")!.archived = { at: now(), byId: ROBERTA };
    const steps = await respond("archive projects with no activity for 90 days", as(ROBERTA));
    expect(said(steps).split("\n")[0]).toBe("2 projects have had no activity for 90 days:");
  });
});

/** Toglie i segnali di un progetto: ogni data a 200 giorni fa. */
function quiet(id: string) {
  const old = new Date(Date.parse(now()) - 200 * 86_400_000).toISOString();
  const tasks = new Set(state.tasks.filter((t) => t.projectId === id).map((t) => t.id));
  for (const t of state.tasks) if (tasks.has(t.id)) t.createdAt = old;
  for (const a of state.activity) if (tasks.has(a.taskId)) a.at = old;
  for (const r of state.requests) if (r.projectId === id) r.createdAt = old;
  for (const d of state.decisionLog) if (d.projectId === id) d.decidedAt = old;
  for (const c of state.supportConversations)
    if (c.projectId === id) for (const m of c.messages) m.at = old;
  for (const p of state.openPrs) if (p.projectId === id) p.openedAt = old;
  for (const r of state.releases) if (r.projectId === id) r.mergedAt = old;
}

describe("S5: aggiungere un membro", () => {
  it("Laura, un Luca visibile e non membro: la frase e una scheda C con `addMember` che avvisa Luca", async () => {
    const steps = await respond("invita Luca come Developer in ACQ", as(LAURA));
    expect(said(steps)).toBe("Luca Bianchi is already in Stubwise, so there's no invite to send.");
    const card = proposalOf(steps)!;
    expect(card.actions).toEqual([
      {
        fn: "addMember",
        args: { projectId: ACQ, personId: LUCA, roleId: DEVELOPER },
        summary: "Add Luca Bianchi to ACQ as Developer",
        summaryText: {
          key: "claude.answers.member.summary",
          params: { name: "Luca Bianchi", code: "ACQ", role: "Developer", context: "vowel" },
        },
      },
    ]);
    expect(card.blocked).toBeUndefined();
    expect(classOfGroup(LAURA, card.actions)).toEqual({
      cls: "C",
      reasons: [{ kind: "notifies", personIds: [LUCA], more: false }, { kind: "reauth" }],
    });
    // Nessun pronome per la persona aggiunta [SC 13].
    expect(said(steps).toLowerCase()).not.toMatch(/\b(him|her|lo|la)\b/);
    // In it, «ad ACQ».
    expect(i18n.getFixedT("it")(card.actions[0]!.summaryText!.key, card.actions[0]!.summaryText!.params)).toBe(
      "Aggiungi Luca Bianchi ad ACQ come Developer",
    );
  });

  it("già membro: una riga, nessuna scheda", async () => {
    const steps = await respond("add Marco to ACQ as Developer", as(LAURA));
    expect(said(steps)).toBe("Marco Bellini is already in ACQ as Developer.");
    expect(proposalOf(steps)).toBeUndefined();
  });

  it("più Luca: una scheda di scelta coi soli visibili, nessuno consigliato; risposta, la scheda C", async () => {
    createPerson({
      name: "Luca Rinaldi",
      email: "luca.rinaldi@example.com",
      password: "a-long-password-1",
      instanceRoleId: "role-user",
      projects: [{ projectId: "prj-aud", roleId: DEVELOPER }],
    });
    // Un terzo Luca solo in un progetto che Laura non vede.
    const hidden = state.projects.find((p) => !visibleProjectIds(LAURA).has(p.id) && !p.archived)!;
    createPerson({
      name: "Luca Verdi",
      email: "luca.verdi@example.com",
      password: "a-long-password-1",
      instanceRoleId: "role-user",
      projects: [{ projectId: hidden.id, roleId: DEVELOPER }],
    });
    const text = "add Luca to ACQ as Developer";
    const steps = await respond(text, as(LAURA));
    expect(proposalOf(steps)).toBeUndefined();
    const q = questionOf(steps)!;
    expect(q.text).toBe("Which Luca should I add to ACQ?");
    expect(q.options).toEqual([{ label: "Luca Bianchi · Sales" }, { label: "Luca Rinaldi" }]);
    expect(JSON.stringify(steps).toLowerCase()).not.toContain("verdi");

    const resumed = await respond(`${text} Luca Rinaldi`, as(LAURA));
    const card = proposalOf(resumed)!;
    const rinaldi = PEOPLE.find((p) => p.name === "Luca Rinaldi")!.id;
    expect(card.actions[0]!.args).toEqual({ projectId: ACQ, personId: rinaldi, roleId: DEVELOPER });
  });

  it("nessun Pietro, chi può invitare: la riga D porta al dialogo compilato, mai un link d'invito né un token", async () => {
    const steps = await respond("invita Pietro come Developer in ACQ", as(ROBERTA, it_));
    expect(proposalOf(steps)).toBeUndefined();
    const route = "#/admin/people?invite=1&inviteProject=ACQ&inviteRole=role-developer";
    expect(said(steps)).toBe(
      `Non trovo Pietro in Stubwise. Un invito manda un link, e lo crea l'app, non io. [Apri l'invito ad ACQ come Developer →](${route})`,
    );
    expect(isAppRoute(route)).toBe(true);
    const json = JSON.stringify(steps);
    expect(json).not.toMatch(/\/invite\//i);
    expect(json).not.toMatch(/token|invite=(?!1)/i);
    expect(json).not.toMatch(/@/);
  });

  it("nessun Pietro, chi non può invitare (Laura): la frase e il «Who?» d'istanza, nessun link al dialogo", async () => {
    const steps = await respond("invite Pietro as Developer in ACQ", as(LAURA));
    expect(proposalOf(steps)).toBeUndefined();
    expect(said(steps)).toBe(
      "I can't find Pietro in Stubwise. An invite sends a link, and the app creates it, not me. Inviting people isn't something you can do here · [Who?](who:invitePeople)",
    );
    expect(said(steps)).not.toContain("#/admin");
  });

  it("chi non vede ACQ: la stessa frase di un codice che non esiste", async () => {
    const hidden = await respond("add Luca to ACQ as Developer", as(GIULIA));
    const missing = await respond("add Luca to QQQ as Developer", as(GIULIA));
    expect(said(hidden)).toBe("I can't find a project ACQ, or you can't see it.");
    expect(said(missing)).toBe(said(hidden).replace("ACQ", "QQQ"));
    expect(proposalOf(hidden)).toBeUndefined();
  });

  it("un ruolo con permessi che Laura lì non ha: la scheda nasce `blocked`", async () => {
    const developer = accessState().roles.find((r) => r.id === DEVELOPER)!;
    const perm = developer.permissions.find((p) => p !== "project.members.manage")!;
    revokeProjectPermission(LAURA, ACQ, perm as never);
    const steps = await respond("add Luca to ACQ as Developer", as(LAURA));
    expect(proposalOf(steps)!.blocked).toEqual({ kind: "escalation", roleId: DEVELOPER });
  });

  it("chi non gestisce i membri: una riga col «Who?», nessuna scheda", async () => {
    // Sara è Contributor in ACQ.
    const steps = await respond("add Luca to ACQ as Developer", as("p-sara"));
    expect(proposalOf(steps)).toBeUndefined();
    expect(said(steps)).toBe("You can't add people to ACQ · [Who?](who:manageMembers/ACQ)");
  });

  it("un ruolo che non esiste: la scheda di scelta coi ruoli di progetto, nessuno consigliato", async () => {
    const text = "add Luca to ACQ as Ninja";
    const steps = await respond(text, as(LAURA));
    const q = questionOf(steps)!;
    expect(q.text).toBe("Which role should Luca Bianchi have in ACQ?");
    expect(q.options).toEqual(
      accessState()
        .roles.filter((r) => r.scope === "project")
        .map((r) => ({ label: r.name })),
    );
    const resumed = await respond(`${text} Viewer`, as(LAURA));
    expect(proposalOf(resumed)!.actions[0]!.args.roleId).toBe("role-viewer");
  });
});

describe("nameList nella frase sopra la scheda (minore T5)", () => {
  it("due persone avvisate: «it notifies A and B», come la riga «Notifies»", async () => {
    // Una task di OLV di qualcun altro, ripianificata e riassegnata: avvisa chi la
    // perde e chi la prende.
    const olv = state.projectsById.get("prj-olv")!;
    const task = state.tasks.find(
      (t) => t.projectId === olv.id && t.assigneeId && t.assigneeId !== GIULIA,
    )!;
    const to = PEOPLE.find(
      (p) =>
        olv.memberIds.includes(p.id) &&
        !p.isClaude &&
        p.id !== GIULIA &&
        p.id !== task.assigneeId,
    )!;
    const steps = await respond(`plan ${task.code} for W47 to ${to.name}`, as(GIULIA));
    const card = proposalOf(steps)!;
    const reason = classOfGroup(GIULIA, card.actions).reasons[0]!;
    expect(reason.kind).toBe("notifies");
    const ids = (reason as { personIds: string[] }).personIds;
    expect(ids).toHaveLength(2);
    const names = ids.map((id) => PEOPLE.find((p) => p.id === id)!.name);
    expect(said(steps)).toBe(`I'm asking first: it notifies ${nameList(en, names)}.`);
    expect(said(steps)).toContain(" and ");
  });
});
