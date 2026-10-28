import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptStep } from "./types";

// Il livello dati che la conversazione (Task 5) usa oltre a quello del
// Task 4: «Ferma» e «Ferma e scrivi» nella conversazione libera passano dalla
// coda dei turni; citazioni e menu della casella; contesto di progetto;
// proposta confermata in parte o eseguita dal dialogo di «Modifica».

// Il motore di intenti si può trattenere: una risposta calcolata DOPO «Ferma»
// non deve entrare nel flusso.
const gate = vi.hoisted(() => ({
  hold: null as null | { release: (steps: ScriptStep[]) => void; promise: Promise<ScriptStep[]> },
}));
vi.mock("../domain/claude/intents", async (importOriginal) => {
  const original = await importOriginal<typeof import("../domain/claude/intents")>();
  return {
    ...original,
    respond: vi.fn((...args: Parameters<typeof original.respond>) =>
      gate.hold ? gate.hold.promise : original.respond(...args),
    ),
  };
});

import {
  completeEditedProposal,
  confirmProposal,
  createConversation,
  getConversation,
  listCommands,
  resetApi,
  resolveCitations,
  runScript,
  searchMentions,
  sendMessage,
  setConversationContext,
  setLatency,
  setStreamLatency,
  setVisibility,
  stop,
  stopAndSend,
  whenIdle,
} from "./api";
import { setSessionPersonId } from "./session";
import { state } from "./store";
import type { ConversationEvent, ProposedAction } from "./types";

beforeEach(() => {
  setLatency(0);
  resetApi();
  gate.hold = null;
  setSessionPersonId("p-giulia");
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(id: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await whenIdle(id);
    await tick();
  }
}
const log = (id: string): ConversationEvent[] => state.conversationEvents.get(id) ?? [];
const conv = (id: string) => state.conversations.find((c) => c.id === id)!;

function holdRespond() {
  let release!: (steps: ScriptStep[]) => void;
  const promise = new Promise<ScriptStep[]>((resolve) => {
    release = resolve;
  });
  gate.hold = { release, promise };
  return release;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++) await tick();
  expect(check()).toBe(true);
}

describe("«Ferma» nella conversazione libera (coda dei turni)", () => {
  it("canInterrupt solo all'autore e solo mentre Claude risponde", async () => {
    const c = await createConversation();
    expect((await getConversation(c.id))!.canInterrupt).toBe(false);
    const release = holdRespond();
    void sendMessage(c.id, { text: "What should I do today?" });
    await until(() => conv(c.id).state === "working");
    expect((await getConversation(c.id))!.canInterrupt).toBe(true);
    // «Ferma» si chiude quando il turno fermato ha finito (qui: la risposta arriva dopo).
    const stopping = stop(c.id);
    await tick();
    release([]);
    await expect(stopping).resolves.toBeUndefined();
    expect((await getConversation(c.id))!.canInterrupt).toBe(false);
  });

  it("una risposta calcolata dopo «Ferma» non entra nel flusso", async () => {
    const c = await createConversation();
    const release = holdRespond();
    const sending = sendMessage(c.id, { text: "What should I do today?" });
    await until(() => log(c.id).some((e) => e.type === "user"));
    const stopping = stop(c.id);
    await tick();
    release([
      { step: "say", text: "A LATE ANSWER" },
      { step: "state", state: "idle" },
    ]);
    await stopping;
    await sending;
    await settle(c.id);
    const events = log(c.id);
    expect(events.some((e) => e.type === "assistant" && e.text.includes("LATE"))).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "phase",
      outcome: "stopped",
      stoppedById: "p-giulia",
    });
    expect(events.find((e) => e.type === "user")).toMatchObject({ delivery: "delivered" });
    expect(conv(c.id).state).toBe("idle");
  });

  it("un messaggio in coda dietro la risposta fermata resta, non consegnato e con il motivo", async () => {
    const c = await createConversation();
    const release = holdRespond();
    const first = sendMessage(c.id, { text: "What should I do today?" });
    await until(() => log(c.id).some((e) => e.type === "user"));
    const second = sendMessage(c.id, { text: "And tomorrow?" });
    await tick();
    const stopping = stop(c.id);
    await tick();
    release([{ step: "say", text: "LATE" }]);
    await Promise.all([first, second, stopping]);
    await settle(c.id);
    const users = log(c.id).filter((e) => e.type === "user");
    expect(users.map((u) => u.type === "user" && u.text)).toEqual([
      "What should I do today?",
      "And tomorrow?",
    ]);
    expect(users[1]).toMatchObject({ delivery: "undelivered" });
    expect(users[1]!.type === "user" && users[1]!.undeliveredReason).toBeTruthy();
    expect(log(c.id).some((e) => e.type === "assistant")).toBe(false);
    // Nulla dopo la fase fermata: il turno in coda non ha risposto.
    expect(log(c.id).at(-1)).toMatchObject({ type: "phase", outcome: "stopped" });
  });

  it("«Ferma e scrivi»: ferma e manda il messaggio come un turno normale (mai il refine)", async () => {
    const c = await createConversation({ contextProjectId: "prj-mkx" });
    const release = holdRespond();
    const sending = sendMessage(c.id, { text: "What should I do today?" });
    await until(() => conv(c.id).state === "working");
    const both = stopAndSend(c.id, "Explain MKX-7 instead");
    await tick();
    gate.hold = null; // il turno nuovo risponde col motore vero
    release([{ step: "say", text: "LATE" }]);
    await Promise.all([sending, both]);
    await settle(c.id);
    const events = log(c.id);
    const stopAt = events.findIndex((e) => e.type === "phase" && e.outcome === "stopped");
    expect(stopAt).toBeGreaterThan(-1);
    const after = events.slice(stopAt + 1);
    expect(after[0]).toMatchObject({ type: "user", text: "Explain MKX-7 instead" });
    expect(after.some((e) => e.type === "work_result")).toBe(false);
    expect(after.some((e) => e.type === "assistant")).toBe(true);
    expect(events.some((e) => e.type === "assistant" && e.text.includes("LATE"))).toBe(false);
    expect(conv(c.id).state).toBe("idle");
  });

  it("chi non è l'autore non ferma (forbidden)", async () => {
    const c = await createConversation();
    const release = holdRespond();
    void sendMessage(c.id, { text: "What should I do today?" });
    await until(() => conv(c.id).state === "working");
    release([]);
    conv(c.id).visibility = "public";
    conv(c.id).publishedProjectIds = [];
    setSessionPersonId("p-marco");
    await expect(stop(c.id)).rejects.toThrow("forbidden");
  });
});

describe("«Ferma» in una pubblica: le regole della trattenuta (R-E6, R-E8)", () => {
  const ID = "cv-giulia-week";
  const CONFIRMED = ["prj-mkx", "prj-olv", "prj-stw"];
  /** Quello che legge chi guarda la pubblica senza esserne l'autore. */
  async function laura() {
    setSessionPersonId("p-laura");
    const detail = (await getConversation(ID))!;
    setSessionPersonId("p-giulia");
    return detail;
  }
  const texts = (events: ConversationEvent[]) =>
    events.map((e) => (e.type === "user" || e.type === "assistant" ? e.text : e.type));

  beforeEach(async () => {
    setStreamLatency(null);
    await setVisibility(ID, "public", { confirmedProjectIds: CONFIRMED });
  });

  it("fermata mentre Claude pensa: il messaggio trattenuto si consegna, poi la fase fermata", async () => {
    const before = (await laura()).events.length;
    const release = holdRespond();
    const sending = sendMessage(ID, { text: "What should I do today?" });
    await until(() =>
      log(ID).some((e) => e.type === "user" && e.text === "What should I do today?"),
    );
    // Trattenuto: chi guarda non lo legge ancora.
    expect((await laura()).events).toHaveLength(before);
    const stopping = stop(ID);
    await tick();
    // La risposta (che toccherebbe AUD) arriva dopo «Ferma»: non conta.
    release([
      { step: "event", event: { type: "citation", refs: [{ kind: "task", id: "t-aud-3" }] } },
      { step: "say", text: "LATE" },
    ]);
    await Promise.all([sending, stopping]);
    await settle(ID);
    const seen = await laura();
    expect(seen.privateTail).toBe(false);
    expect(texts(seen.events.slice(before))).toEqual(["What should I do today?", "phase"]);
    expect(conv(ID).touchedProjectIds).not.toContain("prj-aud");
  });

  it("fermata mentre scrive una risposta che tocca un progetto nuovo: dal messaggio in poi resta privato", async () => {
    setStreamLatency(5);
    const before = (await laura()).events.length;
    const release = holdRespond();
    const sending = sendMessage(ID, { text: "Explain AUD-3" });
    await until(() => log(ID).some((e) => e.type === "user" && e.text === "Explain AUD-3"));
    release([
      { step: "event", event: { type: "citation", refs: [{ kind: "task", id: "t-aud-3" }] } },
      { step: "say", text: Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") },
      { step: "state", state: "idle" },
    ]);
    await until(() => log(ID).some((e) => e.type === "citation" && e.refs[0]?.id === "t-aud-3"));
    await stop(ID);
    await sending;
    await settle(ID);
    // L'autore ha tutto, fase fermata compresa.
    expect(log(ID).at(-1)).toMatchObject({ type: "phase", outcome: "stopped" });
    // Chi guarda: niente dal messaggio in poi (né il messaggio, né AUD, né la fase).
    const seen = await laura();
    expect(seen.privateTail).toBe(true);
    expect(seen.events).toHaveLength(before);
  });

  it("«Ferma e scrivi» in una pubblica: il messaggio nuovo segue la trattenuta", async () => {
    const before = (await laura()).events.length;
    const release = holdRespond();
    const sending = sendMessage(ID, { text: "What should I do today?" });
    await until(() => conv(ID).state === "working");
    const both = stopAndSend(ID, "Explain MKX-7 instead");
    await tick();
    gate.hold = null;
    release([{ step: "say", text: "LATE" }]);
    await Promise.all([sending, both]);
    await settle(ID);
    // MKX è già confermato: il seguito è pubblico.
    let seen = await laura();
    expect(texts(seen.events.slice(before)).slice(0, 3)).toEqual([
      "What should I do today?",
      "phase",
      "Explain MKX-7 instead",
    ]);
    expect(seen.events.some((e) => e.type === "assistant" && e.text.includes("LATE"))).toBe(false);

    // Un «Ferma e scrivi» che tocca un progetto nuovo resta dell'autore.
    const now = seen.events.length;
    const second = holdRespond();
    const again = sendMessage(ID, { text: "What should I do today?" });
    await until(() => conv(ID).state === "working");
    const third = stopAndSend(ID, "Explain AUD-3");
    await tick();
    gate.hold = null;
    second([]);
    await Promise.all([again, third]);
    await settle(ID);
    seen = await laura();
    expect(texts(seen.events.slice(now))).not.toContain("Explain AUD-3");
    expect(seen.privateTail).toBe(true);
  });
});

describe("citazioni", () => {
  it("chi guarda vede codice e nome solo di ciò che può vedere", async () => {
    const refs = [
      { kind: "task", id: "t-aud-3" },
      { kind: "file", id: "audin-app:src/import/match.ts" },
      { kind: "doc", id: "doc-aud-import" },
      { kind: "person", id: "p-marco" },
    ] as const;
    setSessionPersonId("p-marco");
    const forMarco = await resolveCitations([...refs]);
    expect(forMarco.every((c) => c.visible)).toBe(true);
    expect(forMarco[0]).toMatchObject({ code: "AUD-3", projectCode: "AUD" });
    expect(forMarco[0]!.route).toContain("task=AUD-3");
    expect(forMarco[1]).toMatchObject({
      code: "audin-app",
      name: "src/import/match.ts",
      route: null,
    });

    setSessionPersonId("p-sara"); // AUD non lo vede
    const forSara = await resolveCitations([...refs]);
    // R-E9: la task invisibile arriva col solo codice; mai titolo, stato, persona o link.
    expect(forSara[0]).toEqual({
      kind: "task",
      id: "t-aud-3",
      visible: false,
      code: "AUD-3",
      name: null,
      projectCode: null,
      status: null,
      personId: null,
      route: null,
    });
    // File e pagine dei Docs: nulla.
    expect(forSara.slice(1, 3)).toEqual(
      refs
        .slice(1, 3)
        .map(() => expect.objectContaining({ visible: false, code: null, name: null })),
    );
    expect(forSara[3]).toMatchObject({ visible: true, name: expect.any(String) });
  });

  it("traguardi, brief e pagine di Release (schede della Chat) seguono il progetto", async () => {
    const refs = [
      { kind: "milestone", id: "ms-aud-1" },
      { kind: "brief", id: "brief-aud-2026-10-19" },
      { kind: "release", id: "rel-aud-2" },
    ] as const;
    setSessionPersonId("p-marco");
    const forMarco = await resolveCitations([...refs]);
    expect(forMarco[0]).toMatchObject({
      visible: true,
      code: "AUD",
      name: "Private beta",
      projectCode: "AUD",
      route: "#/p/AUD",
    });
    expect(forMarco[1]).toMatchObject({ visible: true, code: "AUD", route: "#/p/AUD" });
    expect(forMarco[1]!.name).toEqual(expect.any(String));
    expect(forMarco[2]).toMatchObject({
      visible: true,
      code: "AUD",
      name: "0.10.0 · Callbacks and import preview",
      route: "#/p/AUD/docs",
    });

    setSessionPersonId("p-sara"); // AUD non lo vede: nulla, nemmeno il codice
    const forSara = await resolveCitations([...refs]);
    for (const c of forSara) {
      expect(c).toMatchObject({ visible: false, code: null, name: null, route: null });
    }
  });
});

describe("menu della casella", () => {
  it("«#» cerca task, richieste, Docs, file e progetti visibili; «@» le persone", async () => {
    setSessionPersonId("p-marco");
    const objects = await searchMentions("import", "objects");
    const kinds = new Set(objects.map((o) => o.ref.kind));
    expect(kinds.has("doc")).toBe(true);
    expect(kinds.has("file")).toBe(true);
    const people = await searchMentions("giu", "people");
    expect(people[0]).toMatchObject({ ref: { kind: "person", id: "p-giulia" } });
    expect(people.every((p) => p.ref.kind === "person")).toBe(true);

    setSessionPersonId("p-sara");
    const forSara = await searchMentions("import", "objects");
    expect(forSara.some((o) => o.projectId === "prj-aud")).toBe(false);
  });

  it("i file solo con repos.view nel progetto", async () => {
    setSessionPersonId("p-laura");
    const files = (await searchMentions("", "objects")).filter((o) => o.ref.kind === "file");
    for (const f of files) {
      expect(["prj-stw", "prj-aud"]).toContain(f.projectId);
    }
  });
});

describe("contesto di progetto della libera", () => {
  it("l'autore lo imposta e «/» mostra le skill di quel progetto; invisibile è not_found", async () => {
    const c = await createConversation();
    await setConversationContext(c.id, "prj-stw");
    expect(conv(c.id).contextProjectId).toBe("prj-stw");
    const commands = await listCommands("prj-stw");
    expect(commands.some((cmd) => cmd.source !== "stubwise")).toBe(true);
    await setConversationContext(c.id, null);
    expect(conv(c.id).contextProjectId).toBeNull();

    setSessionPersonId("p-sara");
    const mine = await createConversation();
    await expect(setConversationContext(mine.id, "prj-aud")).rejects.toThrow("not_found");
    await expect(setConversationContext(c.id, null)).rejects.toThrow("not_found");
  });
});

describe("proposte: conferma in parte e «Modifica»", () => {
  const actions: ProposedAction[] = [
    {
      fn: "createTask",
      args: { projectId: "prj-mkx", title: "Banner copy review" },
      summary: "Create in MKX: “Banner copy review”",
    },
    {
      fn: "createTask",
      args: { projectId: "prj-mkx", title: "Banner photo" },
      summary: "Create in MKX: “Banner photo”",
    },
  ];
  async function propose(id: string) {
    await runScript(id, [
      {
        step: "event",
        event: {
          type: "proposal",
          proposalId: "p1",
          requesterId: "p-giulia",
          actions,
          status: "open",
        },
      },
    ]);
  }

  it("«Confirm selected» esegue solo le righe scelte e lo dice", async () => {
    const c = await createConversation();
    await propose(c.id);
    const before = state.tasks.length;
    const outcome = await confirmProposal(c.id, "p1", { actionIndexes: [1] });
    expect(outcome.status).toBe("confirmed");
    expect(state.tasks).toHaveLength(before + 1);
    expect(state.tasks.at(-1)!.title).toBe("Banner photo");
    expect(log(c.id).find((e) => e.type === "proposal")).toMatchObject({
      status: "confirmed",
      confirmedActions: [1],
    });
  });

  it("una selezione vuota o fuori elenco è invalid e non cambia nulla", async () => {
    const c = await createConversation();
    await propose(c.id);
    await expect(confirmProposal(c.id, "p1", { actionIndexes: [] })).rejects.toThrow("invalid");
    await expect(confirmProposal(c.id, "p1", { actionIndexes: [5] })).rejects.toThrow("invalid");
    expect(log(c.id).find((e) => e.type === "proposal")).toMatchObject({ status: "open" });
  });

  it("un'esecuzione che dipende da una riga non scelta è invalid", async () => {
    const c = await createConversation();
    await runScript(c.id, [
      {
        step: "event",
        event: {
          type: "proposal",
          proposalId: "p2",
          requesterId: "p-giulia",
          status: "open",
          actions: [
            actions[0]!,
            { fn: "startRun", args: { taskFromAction: 0 }, summary: "Start Claude" },
          ],
        },
      },
    ]);
    await expect(confirmProposal(c.id, "p2", { actionIndexes: [1] })).rejects.toThrow("invalid");
  });

  it("eseguita dal dialogo: «Done (edited)» con i codici, solo per chi l'ha chiesta", async () => {
    const c = await createConversation();
    await propose(c.id);
    setSessionPersonId("p-marco");
    await expect(completeEditedProposal(c.id, "p1", ["MKX-1"])).rejects.toThrow("not_found");
    setSessionPersonId("p-giulia");
    await expect(completeEditedProposal(c.id, "p1", ["ZZZ-1"])).rejects.toThrow("invalid");
    await completeEditedProposal(c.id, "p1", ["MKX-1"]);
    expect(log(c.id).find((e) => e.type === "proposal")).toMatchObject({
      status: "confirmed",
      edited: true,
      resultCodes: ["MKX-1"],
    });
  });
});
