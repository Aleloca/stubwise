import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mail, resetApi, setLatency } from "../api";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { now, state, visibleProjectIds } from "../store";
import type { MailMessage } from "../types";

// Area 8, «Clienti in attesa» (piano di 72, W-3 = a, W-4 = b): un cliente
// aspetta ME quando un thread delle MIE caselle (a) è ammesso e di un
// progetto che vedo, (b) ha l'ultimo messaggio da un indirizzo esterno,
// (c) di più di 24 ore fa, (d) senza un nostro messaggio dopo, (e) non è
// rumore. Il giudizio di Claude («serve una mia risposta?») decide: sì →
// la riga col motivo; non ancora giudicato → «da valutare»; no → niente.

const ME = "p-giulia";
const hours = (h: number) => new Date(Date.parse(now()) - h * 3_600_000).toISOString();
const meEmail = () => state.mailboxes.find((b) => b.personId === ME)!.email;
const project = () => {
  const id = [...visibleProjectIds(ME)][0]!;
  return state.projectsById.get(id)!;
};
const customer = { name: "Anna Verdi", email: "anna@cliente.test", personId: null };

let seq = 0;
function msg(threadId: string, over: Partial<MailMessage> = {}): MailMessage {
  seq += 1;
  return {
    id: `wc-${threadId}-${seq}`,
    messageId: `<wc-${threadId}-${seq}@test>`,
    threadId,
    from: customer,
    to: [{ name: "Giulia", email: meEmail(), personId: ME }],
    cc: null,
    subject: "Fattura di ottobre",
    at: hours(30),
    text: "Mi mandate la fattura?",
    quoted: null,
    html: null,
    attachments: [],
    mailboxPersonIds: [ME],
    readByPersonIds: [],
    kind: "email",
    context: false,
    classification: {
      state: "done",
      projectIds: [project().id],
      importance: "normal",
      dueDate: null,
      uncertainProjectIds: [],
    },
    ...over,
  };
}

const judge = (m: MailMessage, judgment: "yes" | "no", reason: string | null = null) =>
  state.mailReplyJudgments.set(`${meEmail()}|${m.id}`, { judgment, reason });

const rows = async () => (await mail.listWaitingCustomers()).items;
const ids = async () => (await rows()).map((r) => r.threadId);

beforeEach(() => {
  resetApi();
  setLatency(0);
  setSessionPersonId(ME);
  // Il seme non conta qui: solo i thread del test.
  state.mailMessages = [];
  state.mailReplyJudgments.clear();
});
afterEach(() => resetApi());

describe("Clienti in attesa dalla posta (R3)", () => {
  it("review M5: il seme ha un «sì» col motivo di Claude", async () => {
    resetApi();
    setSessionPersonId(ME);
    const all = await rows();
    expect(all.some((r) => r.judgment === "yes" && r.reason)).toBe(true);
  });

  it("una riga per il thread che aspetta: giudicato sì, col motivo di Claude", async () => {
    const m = msg("t1");
    state.mailMessages.push(m);
    judge(m, "yes", "Asks for the October invoice and nobody sent it.");
    const out = await mail.listWaitingCustomers();
    expect(out.total).toBe(1);
    expect(out.items[0]).toMatchObject({
      threadId: "t1",
      accountEmail: meEmail(),
      customer: { name: "Anna Verdi", email: "anna@cliente.test" },
      subject: "Fattura di ottobre",
      project: { id: project().id, code: project().code },
      waitingSince: m.at,
      importance: "normal",
      judgment: "yes",
      reason: "Asks for the October invoice and nobody sent it.",
    });
  });

  it("W-4 = b: non ancora giudicato compare «da valutare», senza motivo; giudicato no sparisce", async () => {
    const m = msg("t1");
    state.mailMessages.push(m);
    expect(await rows()).toEqual([expect.objectContaining({ judgment: "pending", reason: null })]);
    judge(m, "no");
    expect(await rows()).toEqual([]);
  });

  it("negativi: meno di 24 h dall'ultimo messaggio ESTERNO; dopo c'è un mio messaggio", async () => {
    state.mailMessages.push(msg("young", { at: hours(5) }));
    state.mailMessages.push(
      msg("mine"),
      msg("mine", { at: hours(26), from: { name: "Giulia", email: meEmail(), personId: ME } }),
    );
    expect(await ids()).toEqual([]);
  });

  it("review I1: l'ultimo è di un COLLEGA con casella → candidato, e decide Claude; attesa e cliente dall'ultimo esterno", async () => {
    const colleague = state.mailboxes.find((b) => b.personId !== ME)!;
    const person = PEOPLE.find((p) => p.id === colleague.personId)!;
    const customerMsg = msg("colleague", { at: hours(40) });
    const reply = msg("colleague", {
      at: hours(2),
      from: { name: person.name, email: colleague.email, personId: person.id },
    });
    state.mailMessages.push(customerMsg, reply);
    const [row] = await rows();
    expect(row).toMatchObject({
      threadId: "colleague",
      judgment: "pending",
      customer: { email: "anna@cliente.test" },
      // L'attesa conta dall'ultimo messaggio esterno, non dalla risposta del collega.
      waitingSince: customerMsg.at,
    });
    // Il collega ha già risposto per intero: Claude dice no, e la riga sparisce.
    judge(reply, "no");
    expect(await ids()).toEqual([]);
  });

  it("(d) un invio partito dopo chiude l'attesa; uno ancora in partenza no", async () => {
    const sent = { name: "Giulia", email: meEmail(), personId: ME };
    state.mailMessages.push(
      msg("sent"),
      msg("sent", { at: hours(25), from: sent, delivery: { state: "sent", sentById: ME } }),
      msg("sending"),
      msg("sending", { at: hours(25), from: sent, delivery: { state: "sending", sentById: ME } }),
    );
    expect(await ids()).toEqual(["sending"]);
  });

  it("(a) solo contesto, o di un progetto che non vedo: niente", async () => {
    state.mailMessages.push(msg("context", { context: true }));
    state.mailMessages.push(
      msg("hidden", {
        classification: {
          state: "done",
          projectIds: ["prj-invisible"],
          importance: "normal",
          dueDate: null,
          uncertainProjectIds: [],
        },
      }),
    );
    expect(await ids()).toEqual([]);
  });

  it("review I2: rumore è solo «nessun progetto e importanza non alta» (l'`ignored` del server), non l'importanza bassa", async () => {
    const base = msg("noise");
    const noise = msg("noise", {
      at: hours(28),
      classification: {
        state: "done",
        projectIds: [],
        importance: "normal",
        dueDate: null,
        uncertainProjectIds: [],
      },
    });
    const low = msg("low", {
      classification: {
        state: "done",
        projectIds: [project().id],
        importance: "low",
        dueDate: null,
        uncertainProjectIds: [],
      },
    });
    state.mailMessages.push(base, noise, low);
    expect(await ids()).toEqual(["low"]);
  });

  it("review I2, W-3 = a: con le proposte spente l'ultimo messaggio non classificato passa (il progetto da un ammesso del thread)", async () => {
    const box = state.mailboxes.find((b) => b.personId === ME)!;
    box.proposalsEnabled = false;
    state.mailMessages.push(
      msg("off", { at: hours(60) }),
      msg("off", { at: hours(30), classification: { state: "off" } }),
    );
    expect(await rows()).toEqual([
      expect.objectContaining({
        threadId: "off",
        judgment: "pending",
        project: expect.objectContaining({ id: project().id }),
      }),
    ]);
  });

  it("solo le MIE caselle: la casella di un collega non compare a me", async () => {
    const colleague = state.mailboxes.find((b) => b.personId !== ME)!;
    state.mailMessages.push(msg("theirs", { mailboxPersonIds: [colleague.personId], to: [] }));
    expect(await ids()).toEqual([]);
  });

  it("dall'attesa più vecchia; al più 20, col totale", async () => {
    for (let i = 0; i < 22; i++) state.mailMessages.push(msg(`t${i}`, { at: hours(30 + i) }));
    const out = await mail.listWaitingCustomers();
    expect(out.total).toBe(22);
    expect(out.items).toHaveLength(20);
    expect(out.items[0]!.threadId).toBe("t21");
  });
});
