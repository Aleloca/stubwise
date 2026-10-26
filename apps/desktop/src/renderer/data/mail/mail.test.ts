import { beforeEach, describe, expect, it } from "vitest";
import { failNext, mail, resetApi, setLatency } from "../api";
import { INCOMING_MESSAGE_ID, MAIL_CASES } from "../seed/mail";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import type { MailMessage } from "../types";
import { candidateProjects, classifyMessage } from "./classify";
import { canSeeMessage } from "./visibility";

const as = (personId: string) => setSessionPersonId(personId);
const AUD = "prj-aud";
const MKX = "prj-mkx";
const STW = "prj-stw";

const msg = (id: string): MailMessage => {
  const m =
    state.mailMessages.find((x) => x.id === id) ?? state.mailIncoming.find((x) => x.id === id);
  if (!m) throw new Error(`no message ${id}`);
  return m;
};
const threadOf = (id: string) => msg(id).threadId;
const threadIds = async (filters = {}) =>
  (await mail.listMailThreads(filters)).map((r) => r.threadId);
const rowOf = async (id: string) =>
  (await mail.listMailThreads()).find((r) => r.threadId === threadOf(id));
const membersOf = (projectId: string) => state.projectsById.get(projectId)?.memberIds ?? [];

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-giulia");
});

describe("Posta: chi vede un messaggio (canSeeMessage)", () => {
  it("mittente, to, cc e proprietari della casella; nessun altro, admin compresi", () => {
    const shared = msg(MAIL_CASES.shared); // da Sofia a Giulia e Matteo, Laura in cc
    expect(canSeeMessage("p-giulia", shared)).toBe(true);
    expect(canSeeMessage("p-matteo", shared)).toBe(true);
    expect(canSeeMessage("p-laura", shared)).toBe(true);
    expect(canSeeMessage("p-marco", shared)).toBe(false); // in AUD, non destinatario
    expect(canSeeMessage("p-roberta", shared)).toBe(false); // admin
    // Mittente del team (Laura → Giulia).
    expect(canSeeMessage("p-laura", msg(MAIL_CASES.stwHigh))).toBe(true);
    // Destinatario senza casella (Marco, nelle note di Gemini).
    expect(canSeeMessage("p-marco", msg(MAIL_CASES.transcript))).toBe(true);
  });
});

describe("Posta: privacy sotto il «vedi come» (Review Focus 1)", () => {
  it("l'admin non vede nessun messaggio: elenco, thread, ricerca, Home", async () => {
    // L'admin vede ogni progetto, ma non la posta di nessuno.
    expect(visibleProjectIds("p-roberta").has(AUD)).toBe(true);
    as("p-roberta");
    expect(await threadIds()).toEqual([]);
    await expect(mail.getMailThread(threadOf(MAIL_CASES.shared))).rejects.toThrow("not_found");
    expect(await mail.searchMail("billing")).toEqual([]);
    expect(await mail.listImportantMail()).toEqual([]);
    expect(await mail.listMailboxes()).toEqual([]);
  });

  it("un collega dello stesso progetto non destinatario: come se non esistesse", async () => {
    as("p-alessia"); // in AUD, in nessuna email
    expect(visibleProjectIds("p-alessia").has(AUD)).toBe(true);
    expect(await threadIds()).not.toContain(threadOf(MAIL_CASES.shared));
    expect(await threadIds({ projectId: AUD })).toEqual([]);
    expect(await mail.searchMail("VAT number")).toEqual([]);
    // Un thread invisibile e un id inesistente rispondono allo stesso modo.
    const hidden = await mail
      .getMailThread(threadOf(MAIL_CASES.shared))
      .catch((e: Error) => e.message);
    const missing = await mail.getMailThread("th-does-not-exist").catch((e: Error) => e.message);
    expect(hidden).toBe("not_found");
    expect(missing).toBe(hidden);
    await expect(mail.markRead(threadOf(MAIL_CASES.shared))).rejects.toThrow("not_found");
  });

  it("un destinatario in cc vede elenco, thread e ricerca anche senza la casella", async () => {
    // Le note della chiamata: a Giulia, Laura in cc, solo nelle caselle di Matteo e Giulia.
    const notes = msg(MAIL_CASES.audLow);
    expect(notes.mailboxPersonIds).not.toContain("p-laura");
    as("p-laura");
    expect(await threadIds()).toContain(notes.threadId);
    const thread = await mail.getMailThread(notes.threadId);
    expect(thread.messages.map((m) => m.id)).toEqual([notes.id]);
    expect((await mail.searchMail("client call")).map((h) => h.id)).toEqual([notes.id]);
  });

  it("il thread restituisce solo i messaggi visibili, in ordine, senza chi altro ha letto", async () => {
    as("p-giulia");
    const thread = await mail.getMailThread("th-stw-onboarding-copy");
    expect(thread.messages).toHaveLength(60);
    const ats = thread.messages.map((m) => m.at);
    expect(ats).toEqual([...ats].sort());
    expect(thread.messages[0]).not.toHaveProperty("readByPersonIds");
    expect(thread.messages[0]!.read).toBe(true);
    expect(thread.messages[59]!.read).toBe(false);
  });
});

describe("Posta: ccn", () => {
  it("una casella che tiene l'email senza il titolare in to/cc non si rivela agli altri", async () => {
    // Laura → Giulia, e Matteo in ccn: l'email è anche nella sua casella.
    const m = msg(MAIL_CASES.stwHigh);
    m.mailboxPersonIds = [...m.mailboxPersonIds, "p-matteo"];
    expect(canSeeMessage("p-matteo", m)).toBe(true);
    const leaks = (x: unknown) => JSON.stringify(x).includes("p-matteo");
    for (const viewer of ["p-giulia", "p-laura"]) {
      as(viewer);
      const thread = await mail.getMailThread(m.threadId);
      expect(thread.messages[0], viewer).not.toHaveProperty("mailboxPersonIds");
      expect(leaks(thread), viewer).toBe(false);
      expect(leaks(await rowOf(m.id)), viewer).toBe(false);
      expect(leaks(await mail.searchMail("copy freeze")), viewer).toBe(false);
    }
  });
});

describe("Posta: righe dell'elenco", () => {
  it("la condivisa: progetto, importanza, scadenza, non letti e proposte aperte", async () => {
    const shared = msg(MAIL_CASES.shared);
    const row = await rowOf(MAIL_CASES.shared);
    expect(row).toMatchObject({
      subject: shared.subject,
      lastAt: shared.at,
      projectIds: [AUD],
      importance: "high",
      unread: 1, // Giulia non l'ha letta
      openProposals: 1,
      analysing: false,
    });
    expect(row!.dueDate).toBe((shared.classification as { dueDate: string }).dueDate);
    expect(row!.participants.map((p) => p.email)).toEqual([shared.from.email]);
    as("p-matteo");
    expect((await rowOf(MAIL_CASES.shared))!.unread).toBe(0);
  });

  it("un progetto invisibile a me non compare in projectIds né nei filtri", async () => {
    // La condivisa classificata anche su STW: Matteo non è in STW.
    const shared = msg(MAIL_CASES.shared);
    if (shared.classification.state !== "done") throw new Error("seed: shared is classified");
    shared.classification = { ...shared.classification, projectIds: [AUD, STW] };
    expect(visibleProjectIds("p-matteo").has(STW)).toBe(false);
    as("p-matteo");
    expect((await rowOf(MAIL_CASES.shared))!.projectIds).toEqual([AUD]);
    expect(await threadIds({ projectId: STW })).toEqual([]);
    const view = (await mail.getMailThread(shared.threadId)).messages[0]!.classification;
    expect(view).toMatchObject({ state: "done", projectIds: [AUD] });
    as("p-giulia");
    expect((await rowOf(MAIL_CASES.shared))!.projectIds).toEqual([AUD, STW]);
  });

  it("le proposte aperte contano solo per i membri del progetto che vedono il messaggio", async () => {
    // Le note di Gemini (AUD): Matteo e Giulia membri; la proposta è aperta.
    as("p-matteo");
    expect((await rowOf(MAIL_CASES.transcript))!.openProposals).toBe(1);
    // Fuori da AUD la riga resta, la proposta no.
    const project = state.projectsById.get(AUD)!;
    project.memberIds = project.memberIds.filter((id) => id !== "p-matteo");
    expect((await rowOf(MAIL_CASES.transcript))!.openProposals).toBe(0);
    // Una proposta confermata non conta.
    as("p-giulia");
    expect((await rowOf(MAIL_CASES.confirmed))!.openProposals).toBe(0);
  });

  it("newsletter e personali: nessun progetto e nessuna proposta", async () => {
    for (const id of [MAIL_CASES.newsletter1, MAIL_CASES.personal]) {
      const row = await rowOf(id);
      expect(row, id).toMatchObject({ projectIds: [], openProposals: 0 });
    }
    expect((await rowOf(MAIL_CASES.newsletter1))!.importance).toBe("low");
  });

  it("filtri: importanza, progetto, testo e casella; ordine dal più recente", async () => {
    const rows = await mail.listMailThreads();
    const lasts = rows.map((r) => r.lastAt);
    expect(lasts).toEqual([...lasts].sort().reverse());
    const high = await mail.listMailThreads({ importance: "high" });
    expect(high.length).toBeGreaterThan(0);
    expect(high.every((r) => r.importance === "high")).toBe(true);
    expect(await threadIds({ projectId: STW })).toContain(threadOf(MAIL_CASES.stwHigh));
    expect(await threadIds({ projectId: STW })).not.toContain(threadOf(MAIL_CASES.shared));
    expect(await threadIds({ q: "vat number" })).toEqual([threadOf(MAIL_CASES.shared)]);
    // La casella: solo una delle mie; quella di un altro è vuota.
    const mine = await threadIds({ mailbox: "giulia.ferri@example.com" });
    expect(mine).toContain(threadOf(MAIL_CASES.shared));
    expect(await threadIds({ mailbox: "matteo.conti@example.com" })).toEqual([]);
  });

  it("in analisi: la riga lo dice e non ha ancora importanza", async () => {
    as("p-matteo");
    expect(await rowOf(MAIL_CASES.pending)).toMatchObject({ analysing: true, importance: null });
  });
});

describe("Posta: caselle e allineamento", () => {
  it("solo le mie caselle; vecchia oltre 5 minuti", async () => {
    const [giulia] = await mail.listMailboxes();
    expect(giulia).toMatchObject({ personId: "p-giulia", stale: false, expired: false });
    as("p-matteo"); // allineata 12 minuti fa
    expect(await mail.listMailboxes()).toEqual([
      expect.objectContaining({ personId: "p-matteo", stale: true, expired: false }),
    ]);
    as("p-marco"); // nessun account Google
    expect(await mail.listMailboxes()).toEqual([]);
  });

  it("il bordo dei 5 minuti: esattamente 5 non è vecchia, un secondo in più sì", async () => {
    const box = state.mailboxes.find((b) => b.personId === "p-giulia")!;
    box.syncedAt = "2026-10-23T11:55:00Z";
    expect((await mail.listMailboxes())[0]!.stale).toBe(false);
    box.syncedAt = "2026-10-23T11:54:59Z";
    expect((await mail.listMailboxes())[0]!.stale).toBe(true);
  });

  it("la casella di un account scaduto è expired, e non si aggiorna", async () => {
    as("p-laura");
    expect(await mail.listMailboxes()).toEqual([
      expect.objectContaining({ personId: "p-laura", expired: true, stale: true }),
    ]);
    await expect(mail.syncMailbox("laura.costa@example.com")).rejects.toThrow(
      "google_not_connected",
    );
  });

  it("«Aggiorna ora»: syncing → ok, arriva il messaggio in coda, syncedAt = adesso", async () => {
    expect(await threadIds()).not.toContain(threadOf(INCOMING_MESSAGE_ID));
    // Con la latenza, l'arrivo resta in viaggio dopo la risposta di «Aggiorna ora».
    setLatency(5);
    await mail.syncMailbox("giulia.ferri@example.com");
    expect(state.mailboxes.find((b) => b.personId === "p-giulia")!.sync).toBe("syncing");
    expect(state.mailMessages.some((m) => m.id === INCOMING_MESSAGE_ID)).toBe(false);
    await mail.whenMailIdle();
    setLatency(0);
    const [box] = await mail.listMailboxes();
    expect(box).toMatchObject({ sync: "ok", syncedAt: "2026-10-23T12:00:00Z", stale: false });
    expect(state.mailIncoming).toEqual([]);
    const row = (await mail.listMailThreads()).find(
      (r) => r.threadId === threadOf(INCOMING_MESSAGE_ID),
    );
    // Classificata dal modello finto: AUD, alta, scadenza domani.
    expect(row).toMatchObject({ projectIds: [AUD], importance: "high", unread: 1 });
    expect(row!.dueDate).toBe("2026-10-24");
    // Non è arrivata a chi non ne è destinatario.
    as("p-matteo");
    expect(await threadIds()).not.toContain(threadOf(INCOMING_MESSAGE_ID));
  });

  it("l'arrivo passa da «in analisi» prima di essere classificato", async () => {
    await mail.syncMailbox("giulia.ferri@example.com");
    await mail.whenMailIdle();
    expect(mail.mailClassificationHistory(INCOMING_MESSAGE_ID)).toEqual(["pending", "done"]);
  });

  it("una classificazione fallita lascia il messaggio arrivato, da riproporre", async () => {
    failNext("mail.advanceClassification");
    await mail.syncMailbox("giulia.ferri@example.com");
    await mail.whenMailIdle();
    expect(msg(INCOMING_MESSAGE_ID).classification).toEqual({ state: "failed" });
    expect((await rowOf(INCOMING_MESSAGE_ID))!.analysing).toBe(false);
  });

  it("un allineamento fallito lascia la casella failed e la posta in coda", async () => {
    failNext("mail.advanceSync");
    await mail.syncMailbox("giulia.ferri@example.com");
    await mail.whenMailIdle();
    const box = state.mailboxes.find((b) => b.personId === "p-giulia")!;
    expect(box).toMatchObject({ sync: "failed", syncedAt: "2026-10-23T11:58:00Z" });
    expect(state.mailIncoming.map((m) => m.id)).toEqual([INCOMING_MESSAGE_ID]);
  });

  it("una casella di un altro non si aggiorna e non si tocca: not_found", async () => {
    await expect(mail.syncMailbox("matteo.conti@example.com")).rejects.toThrow("not_found");
    await expect(mail.setProposalsEnabled("matteo.conti@example.com", false)).rejects.toThrow(
      "not_found",
    );
  });

  it("proposte spente: l'arrivo resta off, non va al modello e non porta proposte", async () => {
    await mail.setProposalsEnabled("giulia.ferri@example.com", false);
    expect(state.mailboxes.find((b) => b.personId === "p-giulia")!.proposalsEnabled).toBe(false);
    await mail.syncMailbox("giulia.ferri@example.com");
    await mail.whenMailIdle();
    const incoming = msg(INCOMING_MESSAGE_ID);
    expect(incoming.classification).toEqual({ state: "off" });
    expect(mail.mailClassificationHistory(INCOMING_MESSAGE_ID)).toEqual(["off"]);
    expect(state.mailProposals.filter((p) => p.sourceId === incoming.messageId)).toEqual([]);
    const row = await rowOf(INCOMING_MESSAGE_ID);
    expect(row).toMatchObject({ projectIds: [], importance: null, analysing: false });
    // Nel seme: la casella di Laura ha le proposte spente.
    const off = msg(MAIL_CASES.lauraOff);
    expect(off.classification).toEqual({ state: "off" });
    expect(state.mailProposals.filter((p) => p.sourceId === off.messageId)).toEqual([]);
  });
});

describe("Posta: letto, Riproponi, Home e ricerca", () => {
  it("markRead segna letti i messaggi che vedo, solo per me", async () => {
    const id = MAIL_CASES.shared;
    expect((await rowOf(id))!.unread).toBe(1);
    await mail.markRead(threadOf(id));
    expect((await rowOf(id))!.unread).toBe(0);
    expect(msg(id).readByPersonIds).toEqual(["p-matteo", "p-laura", "p-giulia"]);
  });

  it("la riga dice quanti messaggi, se ci sono allegati, l'analisi fallita e l'inizio dell'ultimo", async () => {
    const shared = (await rowOf(MAIL_CASES.shared))!;
    expect(shared).toMatchObject({ messages: 1, attachments: true, failed: false });
    expect(shared.snippet).toMatch(/^Hi both, our accountant/);
    const long = (await rowOf(MAIL_CASES.longThread))!;
    expect(long.messages).toBe(60);
    as("p-matteo");
    expect((await rowOf(MAIL_CASES.failed))!.failed).toBe(true);
  });

  it("markUnread rimette da leggere l'ultimo messaggio, solo per me", async () => {
    const id = MAIL_CASES.shared;
    await mail.markRead(threadOf(id));
    await mail.markUnread(threadOf(id));
    expect((await rowOf(id))!.unread).toBe(1);
    expect(msg(id).readByPersonIds).toEqual(["p-matteo", "p-laura"]);
    as("p-marco");
    await expect(mail.markUnread(threadOf(id))).rejects.toThrow("not_found");
  });

  it("reproposeMessage: failed → pending → done", async () => {
    as("p-matteo");
    const id = MAIL_CASES.failed;
    setLatency(5);
    await mail.reproposeMessage(id);
    expect(msg(id).classification).toEqual({ state: "pending" });
    await mail.whenMailIdle();
    expect(mail.mailClassificationHistory(id)).toEqual(["pending", "done"]);
    expect(msg(id).classification).toMatchObject({ state: "done", projectIds: [MKX] });
  });

  it("due caselle, una con le proposte spente: va al modello per l'altra", async () => {
    // La condivisa è nelle caselle di Giulia (accese), Matteo e Laura.
    const shared = msg(MAIL_CASES.shared);
    shared.classification = { state: "failed" };
    await mail.setProposalsEnabled("giulia.ferri@example.com", true);
    as("p-matteo");
    await mail.setProposalsEnabled("matteo.conti@example.com", false);
    await mail.reproposeMessage(shared.id);
    await mail.whenMailIdle();
    expect(mail.mailClassificationHistory(shared.id)).toEqual(["pending", "done"]);
  });

  it("reproposeMessage con le proposte spente in tutte le sue caselle: finisce off", async () => {
    as("p-matteo");
    const id = MAIL_CASES.failed; // solo nella casella di Matteo
    await mail.setProposalsEnabled("matteo.conti@example.com", false);
    await mail.reproposeMessage(id);
    await mail.whenMailIdle();
    expect(msg(id).classification).toEqual({ state: "off" });
    expect(mail.mailClassificationHistory(id)).toEqual(["off"]);
  });

  it("reproposeMessage: solo una fallita, e solo se la vedo", async () => {
    as("p-matteo");
    await expect(mail.reproposeMessage(MAIL_CASES.shared)).rejects.toThrow("invalid");
    as("p-giulia");
    await expect(mail.reproposeMessage(MAIL_CASES.failed)).rejects.toThrow("not_found");
  });

  it("le email importanti per la Home: alte e non lette, dalla più recente", async () => {
    const rows = await mail.listImportantMail();
    expect(rows.map((r) => r.threadId)).toEqual([
      threadOf(MAIL_CASES.stwHigh),
      threadOf(MAIL_CASES.shared),
    ]);
    await mail.markRead(threadOf(MAIL_CASES.shared));
    expect((await mail.listImportantMail()).map((r) => r.threadId)).toEqual([
      threadOf(MAIL_CASES.stwHigh),
    ]);
  });

  it("la ricerca: da 2 caratteri, tutte le parole, senza accenti, dal più recente", async () => {
    expect(await mail.searchMail("v")).toEqual([]);
    const hits = await mail.searchMail("onboarding copy");
    // I 60 della conversazione lunga, più il congelamento dei testi (onboarding, copy).
    expect(hits.filter((h) => h.threadId === "th-stw-onboarding-copy")).toHaveLength(60);
    expect(hits.map((h) => h.id)).toContain(MAIL_CASES.stwHigh);
    const ats = hits.map((h) => h.at);
    expect(ats).toEqual([...ats].sort().reverse());
    expect((await mail.searchMail("METÀ prezzo")).map((h) => h.id)).toEqual([
      MAIL_CASES.hostileHtml,
    ]);
  });
});

describe("Posta: la classificazione scrive le proposte", () => {
  const proposalsOf = (id: string) =>
    state.mailProposals.filter((p) => p.sourceId === msg(id).messageId);

  it("l'arrivo nuovo: una proposta aperta per il suo progetto, che Giulia vede in «Da decidere»", async () => {
    await mail.syncMailbox("giulia.ferri@example.com");
    await mail.whenMailIdle();
    const [p, ...rest] = proposalsOf(INCOMING_MESSAGE_ID);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({
      source: "email",
      projectId: AUD,
      status: "open",
      actions: [
        {
          fn: "createTask",
          args: {
            projectId: AUD,
            title: "Dialer acceptance tests: can we start tomorrow?",
            dueDate: "2026-10-24",
          },
        },
      ],
    });
    expect(p!.excerpt).toMatch(/Please send the checklist/);
    expect((await mail.listMailDecisions()).map((v) => v.proposal.id)).toContain(p!.id);
    expect((await rowOf(INCOMING_MESSAGE_ID))!.openProposals).toBe(1);
  });

  it("«Riproponi» dopo un'analisi fallita la scrive; una seconda classificazione non la raddoppia", async () => {
    as("p-matteo");
    const id = MAIL_CASES.failed;
    expect(proposalsOf(id)).toEqual([]);
    await mail.reproposeMessage(id);
    await mail.whenMailIdle();
    expect(proposalsOf(id)).toEqual([expect.objectContaining({ projectId: MKX, status: "open" })]);
    msg(id).classification = { state: "failed" };
    await mail.reproposeMessage(id);
    await mail.whenMailIdle();
    expect(proposalsOf(id)).toHaveLength(1);
    // La condivisa ha già la sua proposta su AUD: riproposta, resta una.
    as("p-giulia");
    msg(MAIL_CASES.shared).classification = { state: "failed" };
    await mail.reproposeMessage(MAIL_CASES.shared);
    await mail.whenMailIdle();
    expect(proposalsOf(MAIL_CASES.shared).map((p) => p.id)).toEqual(["mp-aud-billing-vat"]);
  });

  it("incerta fra più progetti: una proposta «scegli il progetto», con le azioni per ciascuno", async () => {
    const incoming = state.mailIncoming[0]!;
    incoming.text += "\nAlso: the new listini for the billing export.";
    await mail.syncMailbox("giulia.ferri@example.com");
    await mail.whenMailIdle();
    expect(msg(INCOMING_MESSAGE_ID).classification).toMatchObject({
      projectIds: [],
      uncertainProjectIds: [AUD, MKX],
    });
    const [p, ...rest] = proposalsOf(INCOMING_MESSAGE_ID);
    expect(rest).toEqual([]);
    const choose = p!.actions[0]!;
    expect(choose.fn).toBe("chooseProject");
    expect(choose.args.projectIds).toEqual([AUD, MKX]);
    const byProject = choose.args.actionsByProject as Record<string, { args: { projectId: string } }[]>;
    expect(byProject[AUD]![0]!.args.projectId).toBe(AUD);
    expect(byProject[MKX]![0]!.args.projectId).toBe(MKX);
    await mail.chooseProjectFor(p!.id, MKX);
    expect(proposalsOf(INCOMING_MESSAGE_ID)).toEqual([
      expect.objectContaining({ projectId: MKX }),
    ]);
  });

  it("una newsletter (nessun progetto) non ne scrive", async () => {
    const incoming = state.mailIncoming[0]!;
    incoming.text += "\nUnsubscribe from this newsletter.";
    await mail.syncMailbox("giulia.ferri@example.com");
    await mail.whenMailIdle();
    expect(proposalsOf(INCOMING_MESSAGE_ID)).toEqual([]);
  });
});

describe("Posta: classificazione finta (classify.ts)", () => {
  it("progetti candidati: almeno un destinatario del team è membro", () => {
    const candidates = candidateProjects(msg(MAIL_CASES.shared));
    expect(candidates).toEqual(expect.arrayContaining([AUD, STW, MKX]));
    // Nessun destinatario del team: nessun candidato.
    const outside = { ...msg(MAIL_CASES.shared), to: [], cc: null, mailboxPersonIds: [] };
    expect(candidateProjects(outside)).toEqual([]);
  });

  it("deterministica, dalle parole del messaggio e fra i soli candidati", () => {
    const shared = msg(MAIL_CASES.shared);
    expect(classifyMessage(shared, membersOf)).toEqual(classifyMessage(shared, membersOf));
    expect(classifyMessage(shared, membersOf)).toMatchObject({
      state: "done",
      projectIds: [AUD],
      importance: "high",
    });
    // Senza membri di AUD fra i destinatari, AUD non è candidato.
    expect(classifyMessage(shared, (p) => (p === AUD ? [] : membersOf(p)))).toMatchObject({
      projectIds: [],
    });
  });

  it("newsletter: nessun progetto, importanza bassa", () => {
    expect(classifyMessage(msg(MAIL_CASES.newsletter1), membersOf)).toEqual({
      state: "done",
      projectIds: [],
      importance: "low",
      dueDate: null,
      uncertainProjectIds: [],
    });
  });

  it("incerta fra più progetti: nessun progetto, i candidati in uncertainProjectIds", () => {
    const m = {
      ...msg(MAIL_CASES.failed),
      subject: "Billing for the dealer price lists",
      text: "Who handles the billing of the listini?",
    };
    expect(classifyMessage(m, membersOf)).toMatchObject({
      projectIds: [],
      uncertainProjectIds: [AUD, MKX],
    });
  });
});
