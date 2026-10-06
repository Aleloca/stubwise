import { describe, expect, it, vi } from "vitest";
import { UNKNOWN } from "@stubwise/shared";
import { ApiError, createStubwiseClient } from "../index.js";

const ID = "11111111-1111-4111-8111-111111111111";

function client() {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
    new Response(JSON.stringify({ items: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

/** Un client la cui unica risposta è quella data — per i test di pre-approvazione, dove il body/status conta. */
function clientReturning(status: number, body: unknown) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { c: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}

/** Ticket minimo valido per `ticketDetailSchema`, coi soli campi che i test di pre-approvazione fanno variare. */
function ticketDetail(overrides: {
  planApprovedAt?: string | null;
  planApprovedBy?: { id: string; email: string } | null;
  planApprovalStale?: boolean;
}) {
  return {
    id: ID,
    projectId: ID,
    number: 1,
    title: "Un ticket",
    body: "Corpo",
    type: "task",
    priority: "medium",
    status: "open",
    source: "manual",
    assigneeId: null,
    milestoneId: null,
    effort: null,
    labels: [],
    technicalPayload: null,
    occurrences: 1,
    lastSeenAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    implementationPlan: null,
    originContent: null,
    planSummary: null,
    repositories: [],
    ...overrides,
  };
}

describe("endpoints tickets", () => {
  it("list: unisce `statuses` con la virgola", async () => {
    const { c, fetchImpl } = client();
    await c.tickets.list({ statuses: ["open", "in_progress"] });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("/api/tickets?statuses=open%2Cin_progress");
  });

  it("list: una lista di stati VUOTA non manda il parametro affatto", async () => {
    // Il server risponde 400 a `statuses=` vuoto: mandarlo comunque
    // trasformerebbe "nessun filtro" in un errore.
    const { c, fetchImpl } = client();
    await c.tickets.list({ statuses: [], projectId: ID });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/tickets?projectId=${ID}`);
  });

  it("answerQuestion: fonde la risposta con `questionId` in un corpo solo", async () => {
    const { c, fetchImpl } = client();
    await c.tickets.answerQuestion(ID, ID, { optionIndex: 2 }).catch(() => undefined);
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}/questions/answer`);
    expect(JSON.parse(String(init!.body))).toEqual({ optionIndex: 2, questionId: ID });
  });
  it("preApprovePlan: POST sulla rotta, torna il ticket intero con i tre campi", async () => {
    const detail = ticketDetail({
      planApprovedAt: "2026-09-11T10:00:00.000Z",
      planApprovedBy: { id: ID, email: "maintainer@example.com" },
      planApprovalStale: false,
    });
    const { c, fetchImpl } = clientReturning(200, detail);

    const result = await c.tickets.preApprovePlan(ID);

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}/pre-approve-plan`);
    expect(init!.method).toBe("POST");
    expect(result.planApprovedBy).toEqual({ id: ID, email: "maintainer@example.com" });
  });

  it("preApprovePlan: 409 no_plan — nessun piano da approvare", async () => {
    const { c } = clientReturning(409, { code: "no_plan", message: "…" });
    const error = await c.tickets.preApprovePlan(ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("no_plan");
  });

  it("preApprovePlan: 403 forbidden — un non-admin non passa (il divieto vero resta lato server)", async () => {
    const { c } = clientReturning(403, { code: "forbidden", message: "…" });
    const error = await c.tickets.preApprovePlan(ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).code).toBe("forbidden");
  });

  it("revokePlanApproval: DELETE sulla rotta, idempotente — torna 200 anche su un ticket mai approvato", async () => {
    const detail = ticketDetail({ planApprovedAt: null, planApprovedBy: null, planApprovalStale: false });
    const { c, fetchImpl } = clientReturning(200, detail);

    const result = await c.tickets.revokePlanApproval(ID);

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}/pre-approve-plan`);
    expect(init!.method).toBe("DELETE");
    expect(result.planApprovedAt).toBeNull();
  });

  // IL MERGE DALL'APP (28 set 2026, dettaglio progetto v3 §6): la stessa
  // rotta della coda di rilascio del web, con il suo `requireAdmin`.
  it("release: POST sulla rotta di rilascio con ticket e repository, torna lo sha", async () => {
    const REPO = "22222222-2222-4222-8222-222222222222";
    const { c, fetchImpl } = clientReturning(200, { merged: true, sha: "abc123" });

    const result = await c.tickets.release(ID, REPO);

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}/repositories/${REPO}/release`);
    expect(init!.method).toBe("POST");
    expect(result).toEqual({ merged: true, sha: "abc123" });
  });

  it("release: 409 checks_failed arriva come ApiError col suo codice, non ingoiato", async () => {
    const { c } = clientReturning(409, { code: "checks_failed", message: "…" });
    const error = await c.tickets.release(ID, ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("checks_failed");
  });

  it("activity: chiama il feed del ticket e legge le voci senza chiudere i tipi", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        JSON.stringify([
          {
            kind: "event",
            id: ID,
            eventKind: "status_changed",
            actorId: null,
            payload: { from: "triaged", to: "in_progress" },
            createdAt: "2026-09-01T10:00:00.000Z",
          },
          // Una variante che questa build non conosce: il feed resta leggibile.
          { kind: "deploy", id: ID, createdAt: "2026-09-01T11:00:00.000Z" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const c = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
    const items = await c.tickets.activity(ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/tickets/${ID}/activity`);
    expect(items.map((entry) => entry.kind)).toEqual(["event", "deploy"]);
    expect(items[0]!.payload?.to).toBe("in_progress");
  });

  it("patch: manda SOLO i campi toccati — una patch, non una sostituzione", async () => {
    // Il server applica campo per campo: mandare `assigneeId: undefined` non
    // significa "non toccare" ma "chiave assente dal JSON", ed è proprio ciò
    // che questo test fissa. Un campo azzerato viaggia invece come `null`.
    const { c, fetchImpl } = clientReturning(200, { ...ticketDetail({}), status: "in_progress" });

    await c.tickets.patch(ID, { status: "in_progress", assigneeId: null });

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}`);
    expect(init!.method).toBe("PATCH");
    expect(JSON.parse(String(init!.body))).toEqual({ status: "in_progress", assigneeId: null });
  });

  it("comment: POST col solo corpo, e rilegge il commento creato", async () => {
    const created = {
      id: ID,
      ticketId: ID,
      authorType: "user",
      authorId: ID,
      body: "Ci penso io",
      createdAt: "2026-09-21T10:00:00.000Z",
    };
    const { c, fetchImpl } = clientReturning(201, created);

    const result = await c.tickets.comment(ID, "Ci penso io");

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}/comments`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body))).toEqual({ body: "Ci penso io" });
    expect(result.body).toBe("Ci penso io");
  });

  it("comment senza opzioni: il body è ESATTAMENTE { body } (nessuna chiave di risposta)", async () => {
    const { c, fetchImpl } = clientReturning(201, {
      id: ID,
      ticketId: ID,
      authorType: "user",
      authorId: ID,
      body: "x",
      createdAt: "2026-09-21T10:00:00.000Z",
    });
    await c.tickets.comment(ID, "x");
    // La stringa, non il JSON riletto: `undefined` sparirebbe nel parse, `null`
    // no — e un server vecchio non deve ricevere una chiave che non conosce.
    expect(String(fetchImpl.mock.calls.at(-1)![1]!.body)).toBe('{"body":"x"}');
  });

  it("comment con replyToCommentId: lo manda, e rilegge replyTo", async () => {
    const PARENT = "22222222-2222-4222-8222-222222222222";
    const { c, fetchImpl } = clientReturning(201, {
      id: ID,
      ticketId: ID,
      authorType: "user",
      authorId: ID,
      body: "r",
      createdAt: "2026-09-21T10:00:00.000Z",
      replyTo: { id: PARENT, authorType: "ai", authorName: null, excerpt: "Fix pronto" },
    });
    const result = await c.tickets.comment(ID, "r", { replyToCommentId: PARENT });
    expect(JSON.parse(String(fetchImpl.mock.calls.at(-1)![1]!.body))).toEqual({
      body: "r",
      replyToCommentId: PARENT,
    });
    expect(result.replyTo).toEqual({
      id: PARENT,
      authorType: "ai",
      authorName: null,
      excerpt: "Fix pronto",
      // 0084: il default di un server che non lo manda.
      deleted: false,
    });
  });

  it("editComment: PATCH sulla rotta del commento con { body } esatto, e rilegge il commento", async () => {
    const COMMENT = "33333333-3333-4333-8333-333333333333";
    const { c, fetchImpl } = clientReturning(200, {
      id: COMMENT,
      ticketId: ID,
      authorType: "user",
      authorId: ID,
      body: "corretto",
      createdAt: "2026-10-05T10:00:00.000Z",
      editedAt: "2026-10-05T11:00:00.000Z",
      canEdit: true,
      canDelete: true,
    });
    const result = await c.tickets.editComment(ID, COMMENT, "corretto");
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}/comments/${COMMENT}`);
    expect(init!.method).toBe("PATCH");
    expect(String(init!.body)).toBe('{"body":"corretto"}');
    expect(result).toMatchObject({ body: "corretto", editedAt: "2026-10-05T11:00:00.000Z", canEdit: true });
  });

  it("editComment: una risposta senza i campi nuovi si parsa coi default", async () => {
    const COMMENT = "33333333-3333-4333-8333-333333333333";
    const { c } = clientReturning(200, {
      id: COMMENT,
      ticketId: ID,
      authorType: "user",
      authorId: ID,
      body: "x",
      createdAt: "2026-10-05T10:00:00.000Z",
    });
    const result = await c.tickets.editComment(ID, COMMENT, "x");
    expect(result).toMatchObject({
      editedAt: null,
      deletedAt: null,
      deletedBy: null,
      canEdit: false,
      canDelete: false,
      inDecisionLog: false,
    });
  });

  it("deleteComment: DELETE sulla rotta del commento, senza corpo, 204 → undefined", async () => {
    const COMMENT = "33333333-3333-4333-8333-333333333333";
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    const c = createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl });
    await expect(c.tickets.deleteComment(ID, COMMENT)).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}/comments/${COMMENT}`);
    expect(init!.method).toBe("DELETE");
    expect(init!.body ?? undefined).toBeUndefined();
  });

  it("editComment: un 409 comment_deleted arriva come ApiError col codice", async () => {
    const { c } = clientReturning(409, { code: "comment_deleted", message: "Comment has been deleted" });
    await expect(c.tickets.editComment(ID, ID, "x")).rejects.toMatchObject({ status: 409, code: "comment_deleted" });
  });

  it("comments da un server VECCHIO (senza replyTo): replyTo null", async () => {
    const { c } = clientReturning(200, [
      { id: ID, ticketId: ID, authorType: "user", authorId: ID, body: "Primo", createdAt: "2026-09-21T10:00:00.000Z" },
    ]);
    const items = await c.tickets.comments(ID);
    expect(items[0]!.replyTo).toBeNull();
  });

  it("history: GET /history, e una risposta senza total né campi facoltativi si parsa", async () => {
    const { c, fetchImpl } = clientReturning(200, {
      events: [{ id: "run_started:x", kind: "run_started", at: "2026-10-02T09:00:00.000Z" }],
    });
    const history = await c.tickets.history(ID);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/tickets/${ID}/history`);
    expect(history).toEqual({
      events: [
        {
          id: "run_started:x",
          kind: "run_started",
          at: "2026-10-02T09:00:00.000Z",
          actor: null,
          prNumber: null,
          prUrl: null,
          round: null,
          detail: null,
          fromStatus: null,
        },
      ],
      total: 0,
    });
  });

  it("history: un actor.type ignoto arriva UNKNOWN, un kind ignoto passa", async () => {
    const { c } = clientReturning(200, {
      events: [
        { id: "x:1", kind: "brand_new", at: "2026-10-02T09:00:00.000Z", actor: { type: "robot", name: "r" } },
      ],
      total: 1,
    });
    const history = await c.tickets.history(ID);
    expect(history.events[0]!.kind).toBe("brand_new");
    expect(history.events[0]!.actor).toEqual({ type: UNKNOWN, name: "r" });
  });

  it("comments: un'origine di commento che questa build non conosce non fa saltare l'elenco", async () => {
    // `authorType` è un enum, e gli schemi del client passano da
    // `readerSchema`: una quarta origine deve arrivare come UNKNOWN, non far
    // fallire il parse di TUTTI i commenti su un telefono non aggiornato.
    const { c, fetchImpl } = clientReturning(200, [
      { id: ID, ticketId: ID, authorType: "user", authorId: ID, body: "Primo", createdAt: "2026-09-21T10:00:00.000Z" },
      { id: ID, ticketId: ID, authorType: "webhook", authorId: null, body: "Secondo", createdAt: "2026-09-21T11:00:00.000Z" },
    ]);

    const items = await c.tickets.comments(ID);

    expect(fetchImpl.mock.calls.at(-1)![0]).toBe(`/api/tickets/${ID}/comments`);
    expect(items.map((item) => item.body)).toEqual(["Primo", "Secondo"]);
  });

  it("deleteDesign / deletePlan: DELETE sulle due rotte, nessun corpo", async () => {
    const { c, fetchImpl } = clientReturning(200, ticketDetail({}));

    await c.tickets.deleteDesign(ID);
    const [designUrl, designInit] = fetchImpl.mock.calls.at(-1)!;
    expect(designUrl).toBe(`/api/tickets/${ID}/design`);
    expect(designInit!.method).toBe("DELETE");
    expect(designInit!.body).toBeUndefined();

    await c.tickets.deletePlan(ID);
    const [planUrl, planInit] = fetchImpl.mock.calls.at(-1)!;
    expect(planUrl).toBe(`/api/tickets/${ID}/plan`);
    expect(planInit!.method).toBe("DELETE");
  });

  it("requestCorrection: POST sulla rotta delle correzioni con la nota, torna l'id", async () => {
    const REPO = "22222222-2222-4222-8222-222222222222";
    const CORRECTION = "33333333-3333-4333-8333-333333333333";
    const { c, fetchImpl } = clientReturning(202, { correctionId: CORRECTION });

    const result = await c.tickets.requestCorrection(ID, REPO, { note: "Rinomina anche il test" });

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}/repositories/${REPO}/corrections`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ note: "Rinomina anche il test" });
    expect(result).toEqual({ correctionId: CORRECTION });
  });

  it("requestCorrection: senza nota il corpo è vuoto, non porta `note: undefined`", async () => {
    const { c, fetchImpl } = clientReturning(202, { correctionId: ID });
    await c.tickets.requestCorrection(ID, ID);
    const [, init] = fetchImpl.mock.calls.at(-1)!;
    // Confronto sulla STRINGA: un corpo assente (`undefined`) o `{ note: undefined }`
    // serializzato da qualcun altro non deve passare per "vuoto".
    expect(init!.body).toBe("{}");
  });

  it("requestCorrection: il 409 arriva come ApiError col suo codice, non ingoiato", async () => {
    const { c } = clientReturning(409, { code: "correction_in_flight", message: "…" });
    const error = await c.tickets.requestCorrection(ID, ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("correction_in_flight");
  });

  it("runAi: `resumeCorrectionJobId` viaggia nel corpo, accanto alle altre opzioni", async () => {
    const JOB = "44444444-4444-4444-8444-444444444444";
    const { c, fetchImpl } = clientReturning(202, { jobId: JOB, status: "queued" });

    await c.tickets.runAi(ID, { resumeCorrectionJobId: JOB });

    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(url).toBe(`/api/tickets/${ID}/run-ai`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ resumeCorrectionJobId: JOB });
  });

  it("runAi: senza opzioni nessun corpo — il rilancio di sempre, nessun campo nuovo", async () => {
    const { c, fetchImpl } = clientReturning(202, { jobId: ID, status: "queued" });
    await c.tickets.runAi(ID);
    const [, init] = fetchImpl.mock.calls.at(-1)!;
    expect(init!.body).toBeUndefined();
  });

  it("runAi: 409 `correction_not_held` e 403 `needs_maintainer` arrivano come ApiError col loro codice", async () => {
    // Il client distingue dal `code`, non dallo status: anche `job_in_flight` è 409.
    const notHeld = await clientReturning(409, { code: "correction_not_held", message: "…" })
      .c.tickets.runAi(ID, { resumeCorrectionJobId: ID })
      .catch((e: unknown) => e);
    expect(notHeld).toBeInstanceOf(ApiError);
    expect((notHeld as ApiError).status).toBe(409);
    expect((notHeld as ApiError).code).toBe("correction_not_held");

    const maintainer = await clientReturning(403, { code: "needs_maintainer", message: "…" })
      .c.tickets.runAi(ID, { resumeCorrectionJobId: ID })
      .catch((e: unknown) => e);
    expect(maintainer).toBeInstanceOf(ApiError);
    expect((maintainer as ApiError).status).toBe(403);
    expect((maintainer as ApiError).code).toBe("needs_maintainer");
  });

  /** Una voce PR del dettaglio ticket, SENZA `cycle`: la forma di un server di prima. */
  function prRow(extra: Record<string, unknown> = {}) {
    return {
      repositoryId: ID,
      repositorySlug: "portale-b2b",
      branch: "stubwise/ticket-1",
      prUrl: "https://bitbucket.org/acme/portale-b2b/pull-requests/10",
      prState: "open",
      ...extra,
    };
  }

  it("get: una voce PR senza `cycle` (server vecchio) si legge `cycle: null`, non fa fallire il parse", async () => {
    const { c } = clientReturning(200, { ...ticketDetail({}), repositories: [prRow()] });
    const detail = await c.tickets.get(ID);
    expect(detail.repositories[0]!.cycle).toBeNull();
  });

  it("get: uno stato del ciclo che questa build non conosce diventa UNKNOWN, il resto resta", async () => {
    const { c } = clientReturning(200, {
      ...ticketDetail({}),
      repositories: [
        prRow({
          cycle: {
            state: "paused_by_moon",
            round: 1,
            maxRounds: 3,
            pendingRequest: false,
            lastRequest: { via: "carrier_pigeon", name: "mario.rossi", at: "2026-09-30T10:00:00.000Z" },
            canRequestCorrection: true,
            heldReason: "solar_flare",
          },
        }),
      ],
    });
    const cycle = (await c.tickets.get(ID)).repositories[0]!.cycle!;
    expect(cycle.state).toBe(UNKNOWN);
    expect(cycle.lastRequest!.via).toBe(UNKNOWN);
    expect(cycle.heldReason).toBe(UNKNOWN);
    expect(cycle.round).toBe(1);
    expect(cycle.canRequestCorrection).toBe(true);
  });

  it("get: un ciclo di un server senza `heldReason`/`canResume`/`heldJobId` si legge coi default, senza promesse", async () => {
    const { c } = clientReturning(200, {
      ...ticketDetail({}),
      repositories: [
        prRow({
          cycle: {
            state: "correcting",
            round: 2,
            maxRounds: 3,
            pendingRequest: true,
            lastRequest: { via: "provider", name: "mario.rossi", at: "2026-09-30T10:00:00.000Z" },
            canRequestCorrection: false,
          },
        }),
      ],
    });
    const detail = await c.tickets.get(ID);
    expect(detail.repositories[0]!.cycle).toEqual({
      state: "correcting",
      round: 2,
      maxRounds: 3,
      pendingRequest: true,
      // `platform` assente nella risposta (server di prima di A3): `.default(null)`.
      lastRequest: { via: "provider", platform: null, name: "mario.rossi", at: "2026-09-30T10:00:00.000Z" },
      canRequestCorrection: false,
      // Server di prima di E5/E7/G5: nessuna correzione ferma, nessuna ripresa offerta.
      heldReason: null,
      canResume: false,
      heldJobId: null,
    });
  });

  it("get: SOLO i campi nuovi popolati — un ticket spoglio con una correzione ferma che chi guarda può riprendere", async () => {
    const HELD_JOB = "55555555-5555-4555-8555-555555555555";
    const { c } = clientReturning(200, {
      ...ticketDetail({}),
      repositories: [
        prRow({
          cycle: {
            state: "correcting",
            round: 0,
            maxRounds: 3,
            pendingRequest: false,
            lastRequest: null,
            canRequestCorrection: false,
            heldReason: "budget",
            canResume: true,
            heldJobId: HELD_JOB,
          },
        }),
      ],
    });
    const cycle = (await c.tickets.get(ID)).repositories[0]!.cycle!;
    expect(cycle.heldReason).toBe("budget");
    expect(cycle.canResume).toBe(true);
    expect(cycle.heldJobId).toBe(HELD_JOB);
    expect(cycle.lastRequest).toBeNull();
  });
});
