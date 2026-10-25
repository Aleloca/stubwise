import i18n from "i18next";
import { beforeEach, describe, expect, it } from "vitest";
import { respond, type T } from "../../domain/claude/intents";
import {
  chat,
  docs,
  drive,
  resetApi,
  resolveCitations,
  resolveCodes,
  searchMentions,
  setLatency,
  setStreamLatency,
  whenIdle,
} from "../api";
import { readsAs, sendMessage } from "../api-mutations";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { CitationRef, ScriptStep } from "../types";

// Task 9 (area 5): i file del Drive come citazioni (`drive`), codici
// `AUD-F7` scritti a mano, il menu «#», e Claude che legge i file — tutti
// sopra la stessa regola di visibilità (Review Focus 1): per chi non vede
// il file (progetto invisibile, nascosto, tolto) è identico a un codice
// che non esiste. Leggere per Claude non conta un'apertura.

const as = (personId: string) => setSessionPersonId(personId);
const en = i18n.getFixedT("en") as T;
const it_ = i18n.getFixedT("it") as T;
const F7 = "drv-aud-7";
const F8 = "drv-aud-8"; // nascosto da Laura (seme)
const ref = (id: string): CitationRef => ({ kind: "drive", id });

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-giulia");
});

const said = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "say" ? [s.text] : [])).join("\n");
const cited = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "event" && s.event.type === "citation" ? s.event.refs : []));

async function ask(
  personId: string,
  text: string,
  t: T = en,
  contextProjectId: string | null = null,
) {
  as(personId);
  return respond(text, { personId, contextProjectId, read: readsAs(personId), t, seed: "t9" });
}

describe("citazione drive (R-E9, R-G5)", () => {
  it("chi vede il file legge codice, nome, progetto, tipo, riassunto e dove si apre", async () => {
    const [view] = await resolveCitations([ref(F7)]);
    expect(view).toMatchObject({
      kind: "drive",
      visible: true,
      code: "AUD-F7",
      name: "Contratto quadro Audin 2025",
      projectCode: "AUD",
      route: "#/p/AUD/drive?file=AUD-F7",
    });
    expect(view!.drive).toMatchObject({ type: "document", google: true, unavailable: null });
    expect(view!.drive!.summary).toMatch(/30 working days/);
    expect(view!.drive!.projectName).toBeTruthy();
  });

  it("progetto invisibile, file nascosto e id inesistente si leggono identici", async () => {
    as("p-sara");
    const [invisible, missing] = await resolveCitations([ref(F7), ref("drv-nope")]);
    expect({ ...invisible, id: "x" }).toEqual({ ...missing, id: "x" });
    expect(invisible).toMatchObject({ visible: false, code: null, name: null });
    expect(invisible!.drive).toBeUndefined();
    // Un nascosto: anche per chi lo gestisce, una citazione non lo apre.
    as("p-laura");
    const [hidden, gone] = await resolveCitations([ref(F8), ref("drv-nope")]);
    expect({ ...hidden, id: "x" }).toEqual({ ...gone, id: "x" });
  });

  it("codice scritto a mano: AUD-F7 è un link per chi vede AUD, testo (come AUD-F999) per Sara", async () => {
    const giulia = await resolveCodes(["AUD-F7"]);
    expect(giulia).toHaveLength(1);
    expect(giulia[0]).toMatchObject({ kind: "drive", code: "AUD-F7", visible: true });
    as("p-sara");
    expect(await resolveCodes(["AUD-F7"])).toEqual(await resolveCodes(["AUD-F999"]));
    expect(await resolveCodes(["AUD-F7"])).toEqual([]);
    // Il nascosto è come l'inesistente anche per chi lo gestisce.
    as("p-laura");
    expect(await resolveCodes(["AUD-F8"])).toEqual([]);
  });
});

describe("menu «#»", () => {
  it("trova i file del Drive visibili per nome e codice, dopo task, richieste e pagine", async () => {
    const found = await searchMentions("contratto", "objects");
    const file = found.find((r) => r.ref.kind === "drive");
    expect(file).toMatchObject({ code: "AUD-F7", label: "Contratto quadro Audin 2025" });
    const byCode = await searchMentions("AUD-F7", "objects");
    expect(byCode.some((r) => r.ref.kind === "drive" && r.ref.id === F7)).toBe(true);
    const kinds = (await searchMentions("", "objects")).map((r) => r.ref.kind);
    expect(kinds.indexOf("drive")).toBeGreaterThan(kinds.lastIndexOf("doc"));
  });

  it("non per contenuto, mai un file nascosto né di un progetto invisibile", async () => {
    // «30 working days» è solo nel testo del contratto.
    expect(
      (await searchMentions("working days", "objects")).some((r) => r.ref.kind === "drive"),
    ).toBe(false);
    as("p-laura");
    expect((await searchMentions("bozza superata", "objects")).some((r) => r.ref.id === F8)).toBe(
      false,
    );
    as("p-sara");
    expect((await searchMentions("contratto", "objects")).some((r) => r.ref.kind === "drive")).toBe(
      false,
    );
  });

  it("una pagina dei Docs ha il suo codice (AUD-D1), non quello del progetto", async () => {
    const page = (await searchMentions("", "objects")).find((r) => r.ref.kind === "doc")!;
    expect(page.code).toMatch(/^[A-Z]{2,4}-D\d+$/);
  });
});

describe("Claude legge i file del Drive", () => {
  const Q_EN = "What does the client contract say about delivery times?";
  const Q_IT = "Cosa dice il contratto col cliente sui tempi di consegna?";

  it("cita AUD-F7 col passaggio sui tempi di consegna (en e it)", async () => {
    for (const [q, t] of [
      [Q_EN, en],
      [Q_IT, it_],
    ] as const) {
      const steps = await ask("p-giulia", q, t);
      expect(cited(steps)).toEqual([ref(F7)]);
      expect(said(steps)).toContain("AUD-F7 Contratto quadro Audin 2025");
      expect(said(steps)).toMatch(/30 working days/);
    }
  });

  it("per chi non vede AUD risponde come se il file non esistesse", async () => {
    const steps = await ask("p-sara", Q_EN);
    expect(cited(steps)).toEqual([]);
    expect(said(steps)).not.toMatch(/AUD|Contratto|30 working days/);
    const none = await ask("p-sara", "What does the client contract say about parking spaces?");
    expect(said(steps)).toBe(said(none).replace("parking spaces", "delivery times"));
  });

  it("non legge un file nascosto né uno non disponibile", async () => {
    const contract = state.driveFiles.find((f) => f.id === F7)!;
    contract.unavailable = "access_lost";
    expect(cited(await ask("p-giulia", Q_EN))).toEqual([]);
    contract.unavailable = null;
    contract.hidden = true;
    expect(cited(await ask("p-laura", Q_EN))).toEqual([]);
  });

  it("la lettura di Claude non conta un'apertura", async () => {
    const before = state.driveOpens.length;
    await ask("p-giulia", Q_EN);
    await ask("p-giulia", Q_IT, it_);
    expect(state.driveOpens.length).toBe(before);
  });

  it("le chat dei Docs citano anche i file del Drive del progetto", async () => {
    as("p-giulia");
    const before = (await drive.getDriveFile(F7))!.opensTotal;
    const answer = await docs.askDocs({ projectId: "prj-aud", question: Q_EN });
    expect(answer.refs).toContainEqual(ref(F7));
    expect(answer.text).toContain("AUD-F7 Contratto quadro Audin 2025");
    expect((await drive.getDriveFile(F7))!.opensTotal).toBe(before);
    // In un progetto senza il file la chat dei Docs non lo cita.
    const stw = await docs.askDocs({ projectId: "prj-stw", question: Q_EN });
    expect(stw.refs).not.toContainEqual(ref(F7));
  });

  it("nella sezione Claude della task (sessione di lavoro su AUD) risponde citando il file", async () => {
    setStreamLatency(null);
    const id = "cv-run-aud-5";
    const before = state.driveOpens.length;
    as("p-stefano");
    await sendMessage(id, { text: Q_IT });
    await whenIdle(id);
    const events = [...state.conversationEvents.get(id)!].reverse();
    const citation = events.find((e) => e.type === "citation");
    expect(citation?.type === "citation" && citation.refs).toEqual([ref(F7)]);
    const last = events.find((e) => e.type === "assistant");
    expect(last?.type === "assistant" && last.text).toMatch(/AUD-F7 Contratto quadro Audin 2025/);
    expect(state.driveOpens.length).toBe(before);
  });

  it("@Claude in Chat cita il file; chi non vede AUD legge il gettone tenue senza nome", async () => {
    setStreamLatency(null);
    const call = await chat.sendMessage("ch-announcements", { text: `@Claude ${Q_EN}` });
    const reply = state.chatMessages.find((m) => m.threadOf === call.id && m.kind === "claude")!;
    await chat.whenClaudeIdle(reply.id);
    const done = state.chatMessages.find((m) => m.id === reply.id)!;
    expect(done.citations).toEqual([ref(F7)]);
    expect(done.text).toContain("AUD-F7 Contratto quadro Audin 2025");
    as("p-sara");
    const [hers] = await resolveCitations(done.citations);
    expect(hers).toMatchObject({ visible: false, code: null, name: null });
  });
});
