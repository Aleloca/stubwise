import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatActionEvents, forgetPageStatuses, settlePageEvent } from "./claudeChatActions";
import { setAppClientForTests } from "./client";

// Area 10, F6: `fillField` nella build app. Il server la valida, controlla che
// chi chiede possa scrivere il campo e la registra senza scrivere niente
// (`RENDERER_FNS`); il renderer ne fa l'evento `draft` del prototipo, che il
// runner del riquadro mette nel campo SOLO a pagina aperta, col segno «Bozza
// di Claude». Il salvataggio resta della persona. L'esito vive in memoria per
// persona, come quello delle azioni della pagina.

const CONV = "cccccccc-0000-4000-8000-000000000001";
const PROPOSAL = "dddddddd-0000-4000-8000-0000000000f1";
const TASK = "44444444-4444-4444-8444-444444444444";
const REPO = "11111111-1111-4111-8111-111111111111";

const proposal = (args: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({
    id: PROPOSAL,
    sessionId: CONV,
    actions: [{ fn: "fillField", args }],
    summary: "",
    cls: "A",
    reasons: [],
    status: "confirmed",
    canConfirm: false,
    canCancel: false,
    createdAt: "2026-11-20T10:00:00.000Z",
    ...over,
  }) as never;
const raw = [
  {
    id: "1",
    type: "proposal",
    segmentId: "s1",
    at: "2026-11-20T10:00:00.000Z",
    data: { proposalId: PROPOSAL },
  },
] as never;
const description = { field: "task.description", taskId: TASK, text: "Export the report as CSV." };
const notes = {
  field: "release.notes",
  repositoryId: REPO,
  prNumber: 7,
  text: "- AUD-12 CSV export",
};

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  forgetPageStatuses();
});
afterEach(() => {
  vi.unstubAllEnvs();
  setAppClientForTests(null);
});

describe("fillField nella build app (area 10, F6)", () => {
  it("confermata, la descrizione di una task è la bozza del prototipo, in attesa del riquadro", () => {
    const events = chatActionEvents(raw, {
      proposals: [proposal(description)],
      groups: [],
      codes: new Map(),
    });
    expect(events).toEqual([
      {
        id: `page:${PROPOSAL}:0`,
        at: "2026-11-20T10:00:00.000Z",
        type: "draft",
        field: { kind: "taskDescription", taskId: TASK },
        text: "Export the report as CSV.",
        status: "pending",
      },
    ]);
  });

  it("le note di rilascio: il campo della PR (`<repository>#<numero>`, l'id delle PR della build app)", () => {
    const [event] = chatActionEvents(raw, {
      proposals: [proposal(notes)],
      groups: [],
      codes: new Map(),
    });
    expect(event).toMatchObject({
      type: "draft",
      field: { kind: "releaseNotes", prId: `${REPO}#7` },
      text: "- AUD-12 CSV export",
    });
  });

  // Lotto 7, §1 (72, ae0e9a35d): l'esito si salva sul server, per indice
  // (`POST …/actions/:index/outcome`), e una rilettura lo ritrova
  // (`pageOutcomes`). Un'azione mai partita (letta dalla storia) resta solo
  // qui: la riga offre «Apply», e il server non la dice fallita (1.b).
  it("l'esito del riquadro si salva sul server per indice, e la vista lo ritrova", async () => {
    const outcome = `POST /api/claude/proposals/${PROPOSAL}/actions/0/outcome`;
    const { seen } = (await import("./fakeServer")).installFakeServer({
      [outcome]: (req: { body: unknown }) => ({
        body: { index: 0, status: (req.body as { status: string }).status, at: "2026-11-24T10:00:00.000Z" },
      }),
    });
    await settlePageEvent(CONV, `page:${PROPOSAL}:0`, "placed");
    expect(seen.map((r) => `${r.method} ${r.path} ${JSON.stringify(r.body)}`)).toEqual([
      `${outcome} {"status":"placed"}`,
    ]);
    const [placed] = chatActionEvents(raw, {
      proposals: [proposal(description)],
      groups: [],
      codes: new Map(),
    });
    expect(placed).toMatchObject({ status: "placed" });
    // Un'altra finestra (nessun esito locale): lo stato viene da `pageOutcomes`.
    forgetPageStatuses();
    const [reread] = chatActionEvents(raw, {
      proposals: [
        proposal(description, {
          pageOutcomes: [{ index: 0, status: "changed_after", at: "2026-11-24T10:00:00.000Z" }],
        }),
      ],
      groups: [],
      codes: new Map(),
    });
    expect(reread).toMatchObject({ status: "changed_after" });
    // Una vista di prima (senza `pageOutcomes`): `pending`.
    const [old] = chatActionEvents(raw, { proposals: [proposal(description)], groups: [], codes: new Map() });
    expect(old).toMatchObject({ status: "pending" });
  });

  it("un'azione mai partita resta solo qui: niente al server", async () => {
    const { seen } = (await import("./fakeServer")).installFakeServer({});
    await settlePageEvent(CONV, `page:${PROPOSAL}:0`, "not_run");
    expect(seen).toEqual([]);
    const [event] = chatActionEvents(raw, {
      proposals: [proposal({ kind: "theme", to: "dark" }, { actions: [{ fn: "pageAction", args: { kind: "theme", to: "dark" } }] })],
      groups: [],
      codes: new Map(),
    });
    expect(event).toMatchObject({ type: "pageAction", status: "failed" });
  });

  it("dopo un contenuto non fidato è una scheda B: la frase dice il campo, e nessuna bozza finché non si conferma", () => {
    const open = { cls: "B", status: "open", canConfirm: true, canCancel: true };
    const [task] = chatActionEvents(raw, {
      proposals: [proposal(description, open)],
      groups: [],
      codes: new Map([[TASK, "AUD-12"]]),
    });
    expect(task).toMatchObject({ type: "proposal", status: "open" });
    expect((task as { actions: { summary: string }[] }).actions[0]!.summary).toBe(
      "Draft the description of AUD-12",
    );
    const [pr] = chatActionEvents(raw, {
      proposals: [proposal(notes, open)],
      groups: [],
      codes: new Map(),
    });
    expect((pr as { actions: { summary: string }[] }).actions[0]!.summary).toBe(
      "Draft the release notes of pull request #7",
    );
  });
});
