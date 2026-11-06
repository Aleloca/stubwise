import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n";
import { resetApi, setLatency } from "../api";
import type { MailMessage, MailProposal, MeetingTranscript } from "../model";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { done, ext, mail, person } from "../seed/mail/helpers";
import { state, visibleProjectIds } from "../store";
import { sourceOwnerOf, sourceViewOf } from "./sources";

// La fonte vista da chi legge (11b, Task 1; §21 e Review Focus 3): UNA
// funzione per segno, cronologia, card, Home e risposte del riquadro. Chi
// non può aprire una email o una riunione legge «da un'email di <titolare> ·
// <data>» e basta: nessun oggetto, nessun link, nessuna parola del testo, in
// nessun campo (si guarda tutto il valore, composto in en E in it).
//
// Il seme del 11b non ha ancora email di ACQ (arrivano con il motore): il
// test mette la sua in `state` e lascia vuoti i campi che non provano
// niente. Laura (Project Lead) e Sara (Contributor) sono membri di ACQ;
// Matteo è l'organizzatore della revisione di AUD (seme del calendario),
// Laura ci è invitata, Alessia è di AUD e non c'era.

const LAURA = "p-laura";
const SARA = "p-sara";
const MATTEO = "p-matteo";
const ALESSIA = "p-alessia";
const ACQ = "prj-acq";
const AUD = "prj-aud";

const SUBJECT = "Pagamenti: Stripe confermato";
const BODY = "segretissimo contratto firmato con Stripe";

const EMAIL: MailMessage = mail({
  id: "mm-acq-stripe",
  threadId: "th-acq-stripe",
  from: ext("Fabio Rossi", "fabio@cliente.example"),
  to: [person(LAURA)],
  subject: SUBJECT,
  at: "2026-11-04T09:30:00Z",
  text: BODY,
  mailboxPersonIds: [LAURA],
  classification: done([ACQ], "normal"),
});

const proposalFor = (m: MailMessage, over: Partial<MailProposal>): MailProposal =>
  ({
    id: "mp-acq-stripe",
    source: "email",
    sourceId: m.messageId,
    projectId: ACQ,
    actions: [],
    excerpt: "",
    ...over,
  }) as MailProposal;

const say = (view: { label: { key: string; params?: Record<string, string | number> } }, lng: "en" | "it") =>
  i18n.getFixedT(lng)(view.label.key, view.label.params);

/** Tutto ciò che la vista dice, composto nelle due lingue, in minuscolo. */
const everything = (view: Parameters<typeof say>[0]): string =>
  `${JSON.stringify(view)} ${say(view, "en")} ${say(view, "it")}`.toLowerCase();

beforeEach(() => {
  resetApi();
  setLatency(0);
  state.mailMessages.push(EMAIL);
});
afterEach(() => resetApi());

describe("sourceViewOf, una email", () => {
  it("Laura, destinataria, vede l'oggetto e il link alla conversazione", () => {
    const v = sourceViewOf(LAURA, { kind: "email", id: EMAIL.id }, ACQ);
    expect(v).toMatchObject({
      kind: "email",
      code: null,
      link: "#/mail/th-acq-stripe",
      ownerId: LAURA,
      at: EMAIL.at,
      gone: false,
    });
    expect(v.label.params).toMatchObject({ subject: SUBJECT });
  });

  it("Sara non l'ha ricevuta: «da un'email di laura costa», senza oggetto, link né testo", () => {
    const v = sourceViewOf(SARA, { kind: "email", id: EMAIL.id }, ACQ);
    expect(v.link).toBeNull();
    expect(say(v, "it").toLowerCase()).toContain("da un'email di laura costa");
    expect(say(v, "en").toLowerCase()).toContain("from an email of laura costa");
    // La data c'è («4 nov»), l'oggetto e il testo no, in nessun campo.
    expect(say(v, "it")).toMatch(/4 nov/);
    const all = everything(v);
    for (const word of [...SUBJECT.split(/\W+/), ...BODY.split(/\W+/)])
      if (word.length > 3) expect(all, word).not.toContain(word.toLowerCase());
    expect(all).not.toContain("th-acq-stripe");
    expect(all).not.toContain("fabio");
    expect(v.ownerId).toBe(LAURA);
  });

  it("lo stesso messaggio in due progetti: il titolare è quello del progetto della pagina", () => {
    state.mailProposals.push(
      proposalFor(EMAIL, { projectId: AUD, projectChosenById: MATTEO }),
    );
    expect(sourceViewOf(SARA, { kind: "email", id: EMAIL.id }, ACQ).ownerId).toBe(LAURA);
    expect(sourceViewOf(SARA, { kind: "email", id: EMAIL.id }, AUD).ownerId).toBe(MATTEO);
  });

  it("un'email tolta dallo stato: «source no longer available», senza titolare", () => {
    state.mailMessages = state.mailMessages.filter((m) => m.id !== EMAIL.id);
    const v = sourceViewOf(SARA, { kind: "email", id: EMAIL.id }, ACQ);
    expect(v).toMatchObject({ gone: true, link: null, code: null, ownerId: null, at: null });
    expect(say(v, "en").toLowerCase()).toBe("source no longer available");
    expect(say(v, "it").toLowerCase()).toBe("fonte non più disponibile");
  });
});

describe("sourceViewOf, una riunione", () => {
  const seed = (): MeetingTranscript => state.meetingTranscripts.find((t) => t.eventId !== null)!;

  it("Laura, invitata, vede il titolo e il link; Matteo è l'organizzatore", () => {
    const t = seed();
    const v = sourceViewOf(LAURA, { kind: "meeting", id: t.messageId }, AUD);
    expect(v.kind).toBe("meeting");
    expect(v.link).toMatch(/^#\/mail\//);
    expect(v.ownerId).toBe(MATTEO);
    expect(v.label.params).toMatchObject({ title: "Weekly review with Audin" });
  });

  it("Alessia è di AUD e non c'era: «da una riunione di matteo conti», senza titolo né link", () => {
    const t = seed();
    expect(visibleProjectIds(ALESSIA).has(AUD)).toBe(true);
    const v = sourceViewOf(ALESSIA, { kind: "meeting", id: t.messageId }, AUD);
    expect(v.link).toBeNull();
    expect(say(v, "it").toLowerCase()).toContain("da una riunione di matteo conti");
    expect(say(v, "en").toLowerCase()).toContain("from a meeting of matteo conti");
    const all = everything(v);
    for (const word of ["weekly", "review", "audin", "gemini", "notes", t.docTitle.toLowerCase()])
      expect(all, word).not.toContain(word);
  });

  it("una riunione che non c'è più è «source no longer available»", () => {
    const v = sourceViewOf(LAURA, { kind: "meeting", id: "mm-che-non-c-e" }, AUD);
    expect(v).toMatchObject({ gone: true, link: null });
  });
});

describe("sourceViewOf, decisione, task e rilascio", () => {
  const blind = (projectId: string): string =>
    PEOPLE.find((p) => !visibleProjectIds(p.id).has(projectId))!.id;

  it("un codice invisibile dà il codice e nessun titolo (task e rilascio)", () => {
    const task = state.tasks[0]!;
    const release = state.releases[0]!;
    const taskBlind = blind(task.projectId);
    const releaseBlind = blind(release.projectId);

    const t = sourceViewOf(taskBlind, { kind: "task", id: task.id }, task.projectId);
    expect(t).toMatchObject({ kind: "task", code: task.code, link: null, gone: false });
    expect(everything(t)).not.toContain(task.title.toLowerCase());

    const r = sourceViewOf(releaseBlind, { kind: "release", id: release.id }, release.projectId);
    expect(r).toMatchObject({ kind: "release", code: release.code, link: null });
    expect(everything(r)).not.toContain(release.title.toLowerCase());
  });

  it("visibili: col titolo nell'etichetta e il codice per `CodeLink`", () => {
    const task = state.tasks[0]!;
    const viewer = [...state.projectsById.get(task.projectId)!.memberIds].find(
      (id) => id !== CLAUDE_ID,
    )!;
    const t = sourceViewOf(viewer, { kind: "task", id: task.id }, task.projectId);
    expect(t.code).toBe(task.code);
    expect(t.label.params).toMatchObject({ title: task.title });
    expect(t.ownerId).toBe(CLAUDE_ID);
  });

  it("una decisione: titolo e data se la vede; altrimenti «from a decision you can't see», senza codice", () => {
    const d = state.decisionLog[0]!;
    const seeing = [...state.projectsById.get(d.projectId)!.memberIds].find(
      (id) => id !== CLAUDE_ID,
    )!;
    const seen = sourceViewOf(seeing, { kind: "decision", id: d.id }, d.projectId);
    expect(seen.label.params).toMatchObject({ title: d.title });
    expect(seen.at).toBe(d.decidedAt);
    expect(seen.code).toBeNull();

    const hidden = sourceViewOf(blind(d.projectId), { kind: "decision", id: d.id }, d.projectId);
    expect(say(hidden, "en").toLowerCase()).toBe("from a decision you can't see");
    expect(hidden.code).toBeNull();
    expect(hidden.link).toBeNull();
    expect(everything(hidden)).not.toContain(d.title.toLowerCase());
  });

  it("un task che non esiste più è «source no longer available»", () => {
    expect(sourceViewOf(LAURA, { kind: "task", id: "tk-che-non-c-e" }, ACQ)).toMatchObject({
      gone: true,
      code: null,
    });
  });
});

describe("sourceOwnerOf (chi agisce)", () => {
  it("senza scelta del progetto: il primo dei destinatari con casella che è membro", () => {
    expect(sourceOwnerOf({ kind: "email", id: EMAIL.id }, ACQ)).toBe(LAURA);
  });

  it("`projectChosenById` viene prima di `mailboxPersonIds`", () => {
    state.mailProposals.push(proposalFor(EMAIL, { projectChosenById: MATTEO }));
    expect(sourceOwnerOf({ kind: "email", id: EMAIL.id }, ACQ)).toBe(MATTEO);
  });

  it("la scelta in un altro progetto non conta", () => {
    state.mailProposals.push(proposalFor(EMAIL, { projectId: AUD, projectChosenById: MATTEO }));
    expect(sourceOwnerOf({ kind: "email", id: EMAIL.id }, ACQ)).toBe(LAURA);
  });

  it("riunione: l'organizzatore dell'evento", () => {
    const t = state.meetingTranscripts.find((x) => x.eventId !== null)!;
    expect(sourceOwnerOf({ kind: "meeting", id: t.messageId }, AUD)).toBe(MATTEO);
  });

  it("decisione, task e rilascio: Claude", () => {
    for (const kind of ["decision", "task", "release"] as const)
      expect(sourceOwnerOf({ kind, id: "x" }, ACQ)).toBe(CLAUDE_ID);
  });
});
