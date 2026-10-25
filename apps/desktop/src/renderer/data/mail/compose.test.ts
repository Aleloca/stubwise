import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failNext, mail, resetApi, setLatency } from "../api";
import { MAIL_CASES } from "../seed/mail";
import { setSessionPersonId } from "../session";
import { setStreamLatency, state } from "../store";
import type { MailDraft } from "../types";
import { MAIL_MAX_ATTACHMENTS, MAIL_UNDO_MS, streamClaudeDraft } from "./compose";

const as = (personId: string) => setSessionPersonId(personId);
const AUD = "prj-aud";

const threadOf = (id: string) => state.mailMessages.find((m) => m.id === id)!.threadId;
/** Le note della chiamata: da Matteo a Giulia, Laura in copia. */
const CALL_NOTES = () => threadOf(MAIL_CASES.audLow);
const BILLING = () => threadOf(MAIL_CASES.shared);
const visibleIds = async (threadId: string) =>
  (await mail.getMailThread(threadId)).messages.map((m) => m.id);
const textsOf = async (threadId: string) =>
  (await mail.getMailThread(threadId)).messages.map((m) => m.text);

/** Una risposta di Giulia alle note della chiamata, salvata. */
async function savedReply(body = "Thanks, got them."): Promise<MailDraft> {
  const draft = await mail.getDraft(CALL_NOTES(), "reply");
  return mail.saveDraft({ ...draft, body });
}

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-giulia");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Bozze: una per persona e conversazione", () => {
  it("Rispondi: destinatario, oggetto e messaggio a cui risponde; nulla salvato finché non si salva", async () => {
    const draft = await mail.getDraft(CALL_NOTES(), "reply");
    expect(draft.to.map((a) => a.personId)).toEqual(["p-matteo"]);
    expect(draft.cc).toEqual([]);
    expect(draft.subject).toBe("Re: Notes from today's client call are in the AUD folder");
    expect(draft.replyToMessageId).toBe(MAIL_CASES.audLow);
    expect(draft.body).toBe("");
    expect(await mail.listDrafts()).toEqual([]);
  });

  it("salvata e ritrovata, anche dopo aver guardato come un'altra persona; l'altra non la vede", async () => {
    const saved = await savedReply("Thanks Matteo, I'll read them tonight.");
    as("p-matteo");
    expect(await mail.listDrafts()).toEqual([]);
    expect((await mail.getDraft(CALL_NOTES(), "reply")).body).toBe("");
    await expect(mail.discardDraft(saved.id)).rejects.toThrow("not_found");
    as("p-giulia");
    const again = await mail.getDraft(CALL_NOTES(), "reply");
    expect(again).toEqual(saved);
    expect((await mail.listDrafts()).map((d) => d.id)).toEqual([saved.id]);
  });

  it("passare a Rispondi a tutti o Inoltra tiene il corpo e cambia destinatari e oggetto [A 1]", async () => {
    await savedReply("Body stays.");
    const all = await mail.getDraft(CALL_NOTES(), "replyAll");
    expect(all.body).toBe("Body stays.");
    expect(all.to.map((a) => a.personId)).toEqual(["p-matteo"]);
    expect(all.cc.map((a) => a.personId)).toEqual(["p-laura"]);
    const fwd = await mail.getDraft(CALL_NOTES(), "forward");
    expect(fwd.body).toBe("Body stays.");
    expect(fwd.to).toEqual([]);
    expect(fwd.subject).toBe("Fwd: Notes from today's client call are in the AUD folder");
    // Una sola bozza per la conversazione.
    await mail.saveDraft(fwd);
    expect((await mail.listDrafts()).map((d) => d.mode)).toEqual(["forward"]);
  });

  it("Inoltra porta gli allegati originali, che escono tornando a Rispondi", async () => {
    const fwd = await mail.getDraft(BILLING(), "forward");
    expect(fwd.attachments.map((a) => [a.name, a.as])).toEqual([
      ["billing-export-sample.csv", "copy"],
    ]);
    await mail.saveDraft(fwd);
    expect((await mail.getDraft(BILLING(), "reply")).attachments).toEqual([]);
  });

  it("i destinatari si riconoscono dall'indirizzo, mai dal personId che arriva dal client", async () => {
    const draft = await mail.getDraft(CALL_NOTES(), "reply");
    const saved = await mail.saveDraft({
      ...draft,
      to: [
        { name: "x", email: "MATTEO.CONTI@example.com", personId: null },
        { name: "Someone", email: "someone@else.example", personId: "p-marco" },
      ],
    });
    expect(saved.to.map((a) => a.personId)).toEqual(["p-matteo", null]);
  });

  it("una conversazione che non vedo è not_found; chi non ha la casella non scrive", async () => {
    as("p-marco"); // in AUD, non destinatario delle note
    await expect(mail.getDraft(CALL_NOTES(), "reply")).rejects.toThrow("google_not_connected");
    as("p-giulia");
    await expect(mail.getDraft(threadOf(MAIL_CASES.pending), "reply")).rejects.toThrow("not_found");
    await expect(mail.getDraft(null, "reply")).rejects.toThrow("invalid: mode");
  });

  it("Elimina toglie la bozza", async () => {
    const saved = await savedReply();
    await mail.discardDraft(saved.id);
    expect(await mail.listDrafts()).toEqual([]);
  });
});

describe("Allegati dal Drive", () => {
  const fileOf = (projectId: string, source: "upload" | "google", hidden = false) =>
    state.driveFiles.find(
      (f) =>
        f.projectId === projectId && f.source === source && f.hidden === hidden && !f.unavailable,
    )!;

  it("un file del Drive di Stubwise come copia, un file Google come link [A 8]", async () => {
    const saved = await savedReply();
    const upload = fileOf(AUD, "upload");
    const google = fileOf(AUD, "google");
    await mail.attachDriveFile(saved.id, upload.id);
    const draft = await mail.attachDriveFile(saved.id, google.id);
    expect(draft.attachments).toEqual([
      expect.objectContaining({ driveFileId: upload.id, as: "copy", sizeBytes: upload.sizeBytes }),
      expect.objectContaining({ driveFileId: google.id, as: "link", sizeBytes: 0 }),
    ]);
    // Due volte lo stesso file: uno solo.
    expect((await mail.attachDriveFile(saved.id, upload.id)).attachments).toHaveLength(2);
  });

  it("solo file che vedo: un nascosto o di un progetto non mio è not_found", async () => {
    const saved = await savedReply();
    const hidden = state.driveFiles.find((f) => f.hidden)!;
    // Un file di MKX, dopo che Giulia è uscita dal progetto.
    const foreign = fileOf("prj-mkx", "upload");
    const mkx = state.projectsById.get("prj-mkx")!;
    mkx.memberIds = mkx.memberIds.filter((id) => id !== "p-giulia");
    await expect(mail.attachDriveFile(saved.id, hidden.id)).rejects.toThrow("not_found");
    await expect(mail.attachDriveFile(saved.id, foreign.id)).rejects.toThrow("not_found");
    // Neppure facendolo passare da saveDraft.
    await expect(
      mail.saveDraft({
        ...saved,
        attachments: [{ id: "x", name: "x", sizeBytes: 1, driveFileId: foreign.id, as: "copy" }],
      }),
    ).rejects.toThrow("not_found");
  });

  it(`al massimo ${MAIL_MAX_ATTACHMENTS} allegati; oltre 25 MB la bozza si salva ma non parte`, async () => {
    const saved = await savedReply();
    const many = Array.from({ length: MAIL_MAX_ATTACHMENTS + 1 }, (_, i) => ({
      id: `d${i}`,
      name: `f${i}.pdf`,
      sizeBytes: 10,
      driveFileId: null,
      as: "copy" as const,
    }));
    await expect(mail.saveDraft({ ...saved, attachments: many })).rejects.toThrow(
      "invalid: attachments",
    );
    const big = await mail.saveDraft({
      ...saved,
      attachments: [
        {
          id: "big",
          name: "video.mov",
          sizeBytes: 26 * 1024 * 1024,
          driveFileId: null,
          as: "copy",
        },
      ],
    });
    await expect(mail.sendDraft(big.id)).rejects.toThrow("invalid: too_large");
    expect(state.mailMessages.some((m) => m.delivery)).toBe(false);
  });
});

describe("Invio con «Annulla» per 5 s (Review Focus 4)", () => {
  it("durante i 5 s il messaggio è «sending» solo per chi scrive; poi arriva a tutti i destinatari", async () => {
    vi.useFakeTimers();
    const saved = await savedReply("On it.");
    const { messageId, undoUntil } = await mail.sendDraft(saved.id);
    expect(undoUntil).toBe("2026-10-23T12:00:05.000Z");
    const sent = (await mail.getMailThread(CALL_NOTES())).messages.at(-1)!;
    expect(sent).toMatchObject({
      id: messageId,
      text: "On it.",
      delivery: { state: "sending", sentById: "p-giulia" },
      from: { personId: "p-giulia" },
      read: true,
    });
    // La bozza è partita: non c'è più.
    expect(await mail.listDrafts()).toEqual([]);
    as("p-matteo");
    expect(await visibleIds(CALL_NOTES())).not.toContain(messageId);

    await vi.advanceTimersByTimeAsync(MAIL_UNDO_MS);
    expect(await visibleIds(CALL_NOTES())).toContain(messageId);
    as("p-giulia");
    const after = (await mail.getMailThread(CALL_NOTES())).messages.at(-1)!;
    expect(after.delivery).toEqual({ state: "sent", sentById: "p-giulia" });
    // Marco (AUD, non destinatario) non lo vede.
    expect(state.mailMessages.find((m) => m.id === messageId)!.mailboxPersonIds).toEqual([
      "p-giulia",
      "p-matteo",
    ]);
  });

  it("«Annulla» entro 5 s: nessuna traccia nella conversazione, la bozza torna com'era", async () => {
    vi.useFakeTimers();
    const saved = await savedReply("Oops, wrong text.");
    const before = await textsOf(CALL_NOTES());
    const { messageId } = await mail.sendDraft(saved.id);
    await vi.advanceTimersByTimeAsync(MAIL_UNDO_MS - 1);
    const restored = await mail.undoSend(messageId);
    expect(restored).toEqual({ ...saved, updatedAt: restored.updatedAt });
    expect(await textsOf(CALL_NOTES())).toEqual(before);
    expect(state.mailMessages.some((m) => m.id === messageId)).toBe(false);
    expect((await mail.getDraft(CALL_NOTES(), "reply")).body).toBe("Oops, wrong text.");
    // Il timer non spedisce più nulla.
    await vi.advanceTimersByTimeAsync(MAIL_UNDO_MS * 2);
    expect(state.mailMessages.some((m) => m.id === messageId)).toBe(false);
  });

  it("«Annulla» dopo i 5 s → too_late, e il messaggio resta", async () => {
    vi.useFakeTimers();
    const saved = await savedReply();
    const { messageId } = await mail.sendDraft(saved.id);
    await vi.advanceTimersByTimeAsync(MAIL_UNDO_MS);
    await expect(mail.undoSend(messageId)).rejects.toThrow("too_late");
    expect(await visibleIds(CALL_NOTES())).toContain(messageId);
  });

  it("cambio di persona durante la finestra: l'invio resta di chi l'ha fatto, l'altra non lo vede né lo annulla", async () => {
    vi.useFakeTimers();
    const saved = await savedReply("Sent by Giulia.");
    const { messageId } = await mail.sendDraft(saved.id);
    as("p-laura"); // destinataria? No: la risposta va solo a Matteo.
    expect(await visibleIds(CALL_NOTES())).not.toContain(messageId);
    await expect(mail.undoSend(messageId)).rejects.toThrow("not_found");
    as("p-matteo"); // destinatario, ma l'email non è ancora partita
    expect(await visibleIds(CALL_NOTES())).not.toContain(messageId);
    await expect(mail.undoSend(messageId)).rejects.toThrow("not_found");
    await vi.advanceTimersByTimeAsync(MAIL_UNDO_MS);
    const row = state.mailMessages.find((m) => m.id === messageId)!;
    expect(row.from.personId).toBe("p-giulia");
    expect(row.delivery).toEqual({ state: "sent", sentById: "p-giulia" });
    // Matteo (destinatario) lo vede arrivato, Laura (non destinataria) mai.
    expect(await visibleIds(CALL_NOTES())).toContain(messageId);
    as("p-laura");
    expect(await visibleIds(CALL_NOTES())).not.toContain(messageId);
  });

  it("un'email nuova diventa una conversazione nuova in cima all'elenco", async () => {
    vi.useFakeTimers();
    const draft = await mail.getDraft(null, "new");
    const saved = await mail.saveDraft({
      ...draft,
      to: [{ name: "", email: "marco.bellini@example.com", personId: null }],
      subject: "Kick-off",
      body: "See you Monday.",
    });
    const { messageId } = await mail.sendDraft(saved.id);
    await vi.advanceTimersByTimeAsync(MAIL_UNDO_MS);
    const row = state.mailMessages.find((m) => m.id === messageId)!;
    expect((await mail.listMailThreads())[0]!.threadId).toBe(row.threadId);
    as("p-marco");
    expect((await mail.listMailThreads()).map((r) => r.threadId)).toContain(row.threadId);
    as("p-laura"); // non destinataria
    expect((await mail.listMailThreads()).map((r) => r.threadId)).not.toContain(row.threadId);
  });

  it("la posta in uscita non va al modello: nessuna classificazione, nessuna proposta", async () => {
    vi.useFakeTimers();
    const proposals = state.mailProposals.length;
    const { messageId } = await mail.sendDraft((await savedReply()).id);
    await vi.advanceTimersByTimeAsync(MAIL_UNDO_MS);
    await mail.whenMailIdle();
    expect(state.mailMessages.find((m) => m.id === messageId)!.classification).toEqual({
      state: "off",
    });
    expect(state.mailProposals).toHaveLength(proposals);
  });

  it("controlli prima dell'invio: destinatari, indirizzi validi, account non scaduto", async () => {
    const draft = await savedReply();
    await mail.saveDraft({ ...draft, to: [] });
    await expect(mail.sendDraft(draft.id)).rejects.toThrow("invalid: recipients");
    await mail.saveDraft({ ...draft, to: [{ name: "", email: "not an address", personId: null }] });
    await expect(mail.sendDraft(draft.id)).rejects.toThrow("invalid: address");
    state.googleAccounts.find((a) => a.personId === "p-giulia")!.status = "expired";
    await mail.saveDraft(draft);
    await expect(mail.sendDraft(draft.id)).rejects.toThrow("google_not_connected");
    expect(state.mailMessages.some((m) => m.delivery)).toBe(false);
  });
});

describe("Invio fallito", () => {
  async function bounced() {
    const draft = await savedReply("Keep this text.");
    await mail.saveDraft({
      ...draft,
      to: [...draft.to, { name: "Luca", email: "luca@bounce.example", personId: null }],
    });
    const { messageId } = await mail.sendDraft(draft.id);
    await vi.advanceTimersByTimeAsync(MAIL_UNDO_MS);
    return messageId;
  }

  it("fallito: testo intatto, solo per chi scrive, mai ritentato da solo; «Riprova» riparte con la finestra", async () => {
    vi.useFakeTimers();
    const messageId = await bounced();
    const row = state.mailMessages.find((m) => m.id === messageId)!;
    expect(row.delivery).toEqual({
      state: "failed",
      sentById: "p-giulia",
      error: "address_not_found: luca@bounce.example",
    });
    expect(row.text).toBe("Keep this text.");
    as("p-matteo");
    expect(await visibleIds(CALL_NOTES())).not.toContain(messageId);
    as("p-giulia");
    await vi.advanceTimersByTimeAsync(MAIL_UNDO_MS * 10);
    expect(row.delivery!.state).toBe("failed");

    const retry = await mail.retrySend(messageId);
    expect(retry.messageId).toBe(messageId);
    expect(row.delivery!.state).toBe("sending");
    await vi.advanceTimersByTimeAsync(MAIL_UNDO_MS);
    // Lo stesso indirizzo fallisce di nuovo: resta uno solo, fallito.
    expect(row.delivery!.state).toBe("failed");
    expect(state.mailMessages.filter((m) => m.delivery).length).toBe(1);
    await expect(mail.retrySend(messageId)).resolves.toBeDefined();
    await expect(mail.retrySend(messageId)).rejects.toThrow("invalid: not failed");
  });

  it("«Elimina» (o «Modifica») toglie il tentativo e la bozza torna, intatta", async () => {
    vi.useFakeTimers();
    const messageId = await bounced();
    const draft = await mail.deleteFailedSend(messageId);
    expect(draft.body).toBe("Keep this text.");
    expect(state.mailMessages.some((m) => m.id === messageId)).toBe(false);
    expect((await mail.getDraft(CALL_NOTES(), "reply")).body).toBe("Keep this text.");
  });

  it("un nuovo invio della stessa bozza prende il posto del tentativo fallito", async () => {
    vi.useFakeTimers();
    const messageId = await bounced();
    const draft = await mail.deleteFailedSend(messageId);
    await mail.saveDraft({
      ...draft,
      to: draft.to.filter((a) => !a.email.endsWith("bounce.example")),
    });
    const second = await mail.sendDraft(draft.id);
    await vi.advanceTimersByTimeAsync(MAIL_UNDO_MS);
    expect(state.mailMessages.filter((m) => m.delivery).map((m) => m.delivery!.state)).toEqual([
      "sent",
    ]);
    expect(second.messageId).not.toBe(messageId);
  });
});

describe("Destinatari suggeriti", () => {
  it("persone del team e indirizzi dei messaggi che vedo, il team prima", async () => {
    const hits = await mail.suggestRecipients("ma");
    expect(hits[0]).toMatchObject({ group: "team" });
    expect(hits.length).toBeLessThanOrEqual(8);
    const sofia = await mail.suggestRecipients("sofia");
    expect(sofia).toEqual([
      {
        group: "mail",
        name: "Sofia Marchetti",
        email: "sofia.marchetti@audin.example",
        personId: null,
      },
    ]);
    expect(await mail.suggestRecipients(" ")).toEqual([]);
    // Io non mi suggerisco.
    expect((await mail.suggestRecipients("giulia")).some((s) => s.personId === "p-giulia")).toBe(
      false,
    );
  });

  it("mai un indirizzo visto solo in messaggi che non vedo", async () => {
    // L'ordine di Mix Cucine e Product Weekly sono solo nella casella di Matteo.
    expect(await mail.suggestRecipients("mixcucine")).toEqual([]);
    expect(await mail.suggestRecipients("productweekly")).toEqual([]);
    as("p-matteo");
    expect((await mail.suggestRecipients("mixcucine")).map((s) => s.email)).toEqual([
      "acquisti@mixcucine.example",
    ]);
  });

  it("nemmeno da un invio altrui ancora nei 5 s o fallito", async () => {
    vi.useFakeTimers();
    // Matteo risponde alle note della chiamata a Giulia, con un esterno in copia.
    as("p-matteo");
    const draft = await mail.getDraft(CALL_NOTES(), "reply");
    const saved = await mail.saveDraft({
      ...draft,
      to: [{ name: "", email: "giulia.ferri@example.com", personId: null }],
      cc: [{ name: "Secret", email: "secret@hidden.example", personId: null }],
      body: "x",
    });
    const { messageId } = await mail.sendDraft(saved.id);
    as("p-giulia");
    expect(await mail.suggestRecipients("secret")).toEqual([]);
    // Partita, Giulia ne è destinataria: ora l'indirizzo l'ha visto.
    await vi.advanceTimersByTimeAsync(MAIL_UNDO_MS);
    expect(state.mailMessages.find((m) => m.id === messageId)!.delivery!.state).toBe("sent");
    expect((await mail.suggestRecipients("secret")).map((s) => s.email)).toEqual([
      "secret@hidden.example",
    ]);
  });
});

describe("La bozza di Claude", () => {
  it("si scrive a pezzi nel campo, cita solo task visibili e non invia mai", async () => {
    setStreamLatency(0);
    const pieces: string[] = [];
    const stream = streamClaudeDraft(
      { threadId: BILLING(), hint: "tell them it lands on Monday" },
      (text) => pieces.push(text),
    );
    const outcome = await stream.result;
    expect(outcome.complete).toBe(true);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.at(-1)).toBe(outcome.text);
    expect(outcome.text).toContain("It lands on Monday.");
    expect(outcome.projectId).toBe(AUD);
    expect(outcome.used.length).toBeGreaterThan(0);
    for (const u of outcome.used) expect(state.tasksById.get(u.taskId)!.projectId).toBe(AUD);
    // Nessun messaggio, nessuna bozza salvata.
    expect(state.mailMessages.some((m) => m.delivery)).toBe(false);
    expect(state.mailDrafts).toEqual([]);
  });

  it("chi non è membro del progetto non ne vede le task: la bozza non le cita", async () => {
    setStreamLatency(0);
    const aud = state.projectsById.get(AUD)!;
    aud.memberIds = aud.memberIds.filter((id) => id !== "p-laura");
    as("p-laura"); // in copia sull'email di AUD
    const outcome = await streamClaudeDraft({ threadId: BILLING(), hint: "" }, () => {}).result;
    expect(outcome.projectId).toBeNull();
    expect(outcome.used).toEqual([]);
    for (const task of state.tasks.filter((x) => x.projectId === AUD)) {
      expect(outcome.text).not.toContain(task.title);
    }
    await expect(
      streamClaudeDraft({ threadId: null, hint: "hello", projectId: AUD }, () => {}).result,
    ).rejects.toThrow("not_found");
  });

  it("«Ferma» tiene il testo fin lì; un cambio di persona la ferma", async () => {
    vi.useFakeTimers();
    setStreamLatency(10);
    let last = "";
    const stream = streamClaudeDraft({ threadId: BILLING(), hint: "" }, (text) => {
      last = text;
    });
    await vi.advanceTimersByTimeAsync(25);
    stream.stop();
    await vi.runAllTimersAsync();
    const stopped = await stream.result;
    expect(stopped.complete).toBe(false);
    expect(stopped.text).toBe(last);
    expect(last.length).toBeGreaterThan(0);

    const other = streamClaudeDraft({ threadId: BILLING(), hint: "" }, () => {});
    await vi.advanceTimersByTimeAsync(15);
    as("p-matteo");
    await vi.runAllTimersAsync();
    expect((await other.result).complete).toBe(false);
  });

  it("un errore lascia il testo com'era: la chiamata fallisce", async () => {
    failNext("mail.draftReply");
    const texts: string[] = [];
    await expect(
      streamClaudeDraft({ threadId: BILLING(), hint: "" }, (t) => texts.push(t)).result,
    ).rejects.toThrow("Simulated failure");
    expect(texts).toEqual([]);
  });
});
