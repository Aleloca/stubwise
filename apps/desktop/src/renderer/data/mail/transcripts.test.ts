import { beforeEach, describe, expect, it } from "vitest";
import { mail, resetApi, setLatency } from "../api";
import { daysFromToday } from "../seed/dates";
import { EV_AUD_REVIEW_YESTERDAY, MAIL_CASES } from "../seed/mail";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { MeetingTranscript } from "../types";
import { canSeeTranscript } from "./transcripts";

const as = (personId: string) => setSessionPersonId(personId);
const AUD = "prj-aud";
const REVIEW = "mp-aud-weekly-review"; // 4 createTask, l'ultima per Chiara (fuori da AUD)

const transcript = (messageId: string): MeetingTranscript =>
  state.meetingTranscripts.find((t) => t.messageId === messageId)!;
const AUD_NOTES = () => transcript(MAIL_CASES.transcript);
const MKX_NOTES = () => transcript(MAIL_CASES.transcriptUnreachable);
const message = (id: string) => state.mailMessages.find((m) => m.id === id)!;
const event = (id: string) => state.calendarEvents.find((e) => e.id === id)!;

/** Giulia conferma le tre task della revisione di ieri senza quella di Chiara. */
async function confirmReview(): Promise<string[]> {
  as("p-giulia");
  const out = await mail.confirmMailProposal(REVIEW, { actionIndexes: [0, 1, 2] });
  if (out.status !== "confirmed") throw new Error("not confirmed");
  return out.resultCodes;
}

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-giulia");
});

describe("Riunioni registrate: chi vede riassunto e trascrizione (canSeeTranscript)", () => {
  it("i partecipanti dell'evento in Stubwise; non un membro del progetto che non c'era, né l'admin", () => {
    for (const p of ["p-giulia", "p-matteo", "p-laura", "p-marco"]) {
      expect(canSeeTranscript(p, AUD_NOTES())).toBe(true);
    }
    expect(state.projectsById.get(AUD)!.memberIds).toContain("p-alessia");
    expect(canSeeTranscript("p-alessia", AUD_NOTES())).toBe(false);
    expect(canSeeTranscript("p-roberta", AUD_NOTES())).toBe(false);
    expect(canSeeTranscript("p-chiara", AUD_NOTES())).toBe(false);
  });

  it("chi era invitato e ha rifiutato la vede comunque (R-I15)", () => {
    const marco = event(EV_AUD_REVIEW_YESTERDAY).attendees.find((a) => a.personId === "p-marco")!;
    marco.response = "declined";
    expect(canSeeTranscript("p-marco", AUD_NOTES())).toBe(true);
  });

  it("senza evento collegato: solo i destinatari dell'email di Gemini", () => {
    expect(MKX_NOTES().eventId).toBeNull();
    expect(canSeeTranscript("p-giulia", MKX_NOTES())).toBe(true);
    expect(canSeeTranscript("p-chiara", MKX_NOTES())).toBe(true);
    expect(canSeeTranscript("p-matteo", MKX_NOTES())).toBe(false);
    expect(canSeeTranscript("p-roberta", MKX_NOTES())).toBe(false);
  });
});

describe("Riunioni registrate: getMeetingSummary", () => {
  it("a un partecipante: riassunto, trascrizione e l'email di Gemini", async () => {
    const s = await mail.getMeetingSummary(EV_AUD_REVIEW_YESTERDAY);
    expect(s).toMatchObject({
      eventId: EV_AUD_REVIEW_YESTERDAY,
      doc: "ready",
      summary: AUD_NOTES().summary,
      transcript: AUD_NOTES().transcript,
      email: {
        threadId: message(MAIL_CASES.transcript).threadId,
        sourceId: message(MAIL_CASES.transcript).messageId,
      },
    });
  });

  it("un membro non partecipante, l'admin e un evento inesistente: null", async () => {
    as("p-alessia");
    expect(await mail.getMeetingSummary(EV_AUD_REVIEW_YESTERDAY)).toBeNull();
    as("p-roberta");
    expect(await mail.getMeetingSummary(EV_AUD_REVIEW_YESTERDAY)).toBeNull();
    as("p-giulia");
    expect(await mail.getMeetingSummary("ev-nope")).toBeNull();
  });

  it("documento non raggiungibile: nessun riassunto né trascrizione, e lo stato esposto", async () => {
    AUD_NOTES().doc = "unreachable";
    const s = await mail.getMeetingSummary(EV_AUD_REVIEW_YESTERDAY);
    expect(s).toMatchObject({ doc: "unreachable", summary: null, transcript: null });
  });

  it("un partecipante che non ha l'email: il riassunto sì, il link all'email no", async () => {
    const m = message(MAIL_CASES.transcript);
    m.to = m.to.filter((a) => a.personId !== "p-marco");
    as("p-marco");
    const s = await mail.getMeetingSummary(EV_AUD_REVIEW_YESTERDAY);
    expect(s?.summary).toBe(AUD_NOTES().summary);
    expect(s?.email).toBeNull();
  });
});

describe("Riunioni registrate: tasksBornFrom", () => {
  it("nulla finché la proposta della trascrizione è aperta", async () => {
    expect(await mail.tasksBornFrom(EV_AUD_REVIEW_YESTERDAY)).toEqual([]);
  });

  it("le task create confermando la proposta, visibili a un membro che non c'era, con lo stato di adesso", async () => {
    const codes = await confirmReview();
    expect(codes).toHaveLength(3);
    const [first, second, third] = codes.map((c) => state.tasks.find((t) => t.code === c)!);
    // In ritardo: scadenza passata. Chiusa: uno stato «closed» del progetto.
    second!.dueDate = daysFromToday(-2);
    third!.statusId = state.statuses.find((s) => s.projectId === AUD && s.family === "closed")!.id;

    as("p-alessia");
    const born = (await mail.tasksBornFrom(EV_AUD_REVIEW_YESTERDAY))!;
    expect(born.map((t) => t.code)).toEqual(codes);
    expect(born.map((t) => t.status)).toEqual(["open", "late", "done"]);
    expect(born[0]).toMatchObject({
      kind: "task",
      id: first!.id,
      title: first!.title,
      dueDate: first!.dueDate,
      departmentId: first!.departmentId,
    });
    // E il riassunto, a lei, no.
    expect(await mail.getMeetingSummary(EV_AUD_REVIEW_YESTERDAY)).toBeNull();
  });

  it("chi non vede il progetto non vede le task nate", async () => {
    await confirmReview();
    as("p-chiara");
    expect(await mail.tasksBornFrom(EV_AUD_REVIEW_YESTERDAY)).toBeNull();
  });

  it("solo ai membri del progetto (R-I21): un partecipante non membro ha il riassunto, non le task", async () => {
    await confirmReview();
    const e = event(EV_AUD_REVIEW_YESTERDAY);
    for (const [personId, name] of [
      ["p-chiara", "Chiara"],
      ["p-roberta", "Roberta Fontana"], // full admin: vede ogni task, ma non è membro
    ] as const) {
      e.attendees.push({
        personId,
        name,
        email: `${personId}@example.com`,
        response: "accepted",
        organizer: false,
      });
      as(personId);
      expect(await mail.getMeetingSummary(EV_AUD_REVIEW_YESTERDAY)).not.toBeNull();
      expect(await mail.tasksBornFrom(EV_AUD_REVIEW_YESTERDAY)).toBeNull();
    }
  });

  it("una richiesta nata dalla riunione compare come richiesta", async () => {
    const p = state.mailProposals.find((x) => x.id === REVIEW)!;
    p.actions = [
      {
        fn: "createRequest",
        args: { projectId: AUD, title: "Export the call log for the client", description: "" },
        summary: "Request in AUD",
      },
    ];
    const out = await mail.confirmMailProposal(REVIEW);
    expect(out.status).toBe("confirmed");
    const born = (await mail.tasksBornFrom(EV_AUD_REVIEW_YESTERDAY))!;
    expect(born).toHaveLength(1);
    expect(born[0]).toMatchObject({
      kind: "request",
      title: "Export the call log for the client",
      status: "open",
      inProgress: false,
    });
  });
});

describe("Riunioni registrate: le note nella conversazione della Posta", () => {
  const threadId = () => message(MAIL_CASES.transcript).threadId;

  it("un partecipante vede riassunto ed evento", async () => {
    const thread = await mail.getMailThread(threadId());
    const note = thread.messages.find((m) => m.kind === "transcript")!.meeting;
    expect(note).toMatchObject({
      visible: true,
      doc: "ready",
      summary: AUD_NOTES().summary,
      event: { id: EV_AUD_REVIEW_YESTERDAY, title: "AUD weekly review", people: 4 },
    });
  });

  it("un destinatario che non c'era (email inoltrata): né riassunto, né trascrizione, né evento", async () => {
    const m = message(MAIL_CASES.transcript);
    m.to.push({ name: "Alessia Neri", email: "alessia@stubwise.example", personId: "p-alessia" });
    as("p-alessia");
    const thread = await mail.getMailThread(threadId());
    const note = thread.messages.find((x) => x.kind === "transcript")!.meeting;
    expect(note).toMatchObject({ visible: false, summary: null, transcript: null, event: null });
    // Né lo stato né il titolo del Google Doc: solo ciò che dice già l'email.
    expect(note).toMatchObject({ doc: null, docTitle: null });
  });

  it("un'email normale non ha note", async () => {
    const thread = await mail.getMailThread(message(MAIL_CASES.shared).threadId);
    expect(thread.messages.length).toBeGreaterThan(0);
    expect(thread.messages.every((m) => m.meeting === undefined)).toBe(true);
  });
});
