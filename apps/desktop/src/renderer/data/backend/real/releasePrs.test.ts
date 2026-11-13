import { ApiError } from "@stubwise/api-client";
import { describe, expect, it } from "vitest";
import type { OpenPull, ReleaseQueueItem } from "@stubwise/shared";
import { createRealPrs, type PrsApi } from "./releasePrs";

// Area 8, F1 (`releases-prs`): le PR aperte, la coda, il merge in due passi,
// «Chiedi modifiche» e «Solo analisi» sulle rotte vere, con le firme del
// prototipo. Stato, prontezza e permessi li calcola il server.

const REPO = "11111111-1111-4111-8111-111111111111";
const TICKET = "22222222-2222-4222-8222-222222222222";
const pull = (over: Partial<OpenPull> = {}): OpenPull => ({
  origin: "stubwise",
  ticketId: TICKET,
  ticketNumber: 12,
  ticketTitle: "Checkout",
  repositoryId: REPO,
  repositoryName: "audin-app",
  branch: "stubwise/ticket-12",
  baseBranch: "main",
  prUrl: "https://github.com/audin/audin-app/pull/246",
  prNumber: 246,
  headSha: "a".repeat(40),
  createdAt: "2026-11-13T09:00:00.000Z",
  checks: { status: "success", checks: [] },
  deployedOn: [],
  analysis: { verdict: "approve", summary: "Tutto bene", stale: false },
  corrections: { count: 0, lastStatus: null },
  cap: 3,
  analysisOnly: null,
  prState: { state: "clean", autoRound: 0, canAutoCorrect: false },
  ready: true,
  fromFork: false,
  mergeable: null,
  colleaguePrs: "analyze_only",
  issues: [],
  permissions: { analysisOnly: false, requestCorrection: true, editReleaseNotes: true },
  ...over,
});

function fakeApi(over: Partial<PrsApi> = {}) {
  const calls: string[] = [];
  const api: PrsApi = {
    pulls: async (projectId) => (calls.push(`GET ${projectId}/pulls`), { items: [pull()] }),
    queue: async () => (
      calls.push("GET release-queue"),
      { items: [{ repositoryId: REPO, prNumber: 246, projectId: "p1" } as ReleaseQueueItem] }
    ),
    merge: async (ticketId, repositoryId) => (
      calls.push(`POST ${ticketId}/${repositoryId}/release`),
      { merged: true, sha: "b".repeat(40), releaseCode: "AUD-V7" }
    ),
    requestCorrection: async (ticketId, repositoryId, body) => (
      calls.push(`POST ${ticketId}/${repositoryId}/corrections ${body.note}`),
      { correctionId: "33333333-3333-4333-8333-333333333333" }
    ),
    releaseNotes: async (repositoryId, prNumber) => (
      calls.push(`GET ${repositoryId}/${prNumber}/release-notes`),
      {
        repositoryId,
        prNumber,
        body: null,
        updatedById: null,
        updatedAt: null,
        draft: { text: "- AUD-12: Checkout", sources: ["AUD-12"] },
        commitsRead: true,
        canEdit: true,
      }
    ),
    putReleaseNotes: async (repositoryId, prNumber, body) => (
      calls.push(`PUT ${repositoryId}/${prNumber}/release-notes ${body}`),
      {
        repositoryId,
        prNumber,
        body,
        updatedById: "ada",
        updatedAt: "2026-11-13T10:00:00.000Z",
        draft: { text: "", sources: [] },
        commitsRead: true,
        canEdit: true,
      }
    ),
    myReleases: async () => (
      calls.push("GET me/releases"),
      {
        failed: [{ code: "AUD-V3" } as never],
        ready: [pull({ projectId: "p1" } as never), pull({ prNumber: 300 })],
      }
    ),
    analysisOnly: async (repositoryId, prNumber, on) => (
      calls.push(`${on ? "POST" : "DELETE"} ${repositoryId}/${prNumber}/analysis-only`),
      { analysisOnly: on ? { byId: "ada", at: "2026-11-13T10:00:00.000Z" } : null }
    ),
    ...over,
  };
  return { api, calls };
}
const codeOf = async () => "AUD";
const release = async (code: string) => ({ code }) as never;

describe("le PR aperte della build app (area 8, F1)", () => {
  it("una PR nella forma del prototipo: Claude per una di Stubwise, la task, i controlli, lo stato del server", async () => {
    const { api } = fakeApi();
    const [pr] = await createRealPrs(api, codeOf, release).listOpenPrs("p1");
    expect(pr).toMatchObject({
      number: 246,
      repo: "audin-app",
      // L'indirizzo vero del server (review F1, I1): i link non lo costruiscono.
      url: "https://github.com/audin/audin-app/pull/246",
      title: "Checkout",
      origin: "stubwise",
      authorName: "Claude",
      taskCode: "AUD-12",
      checks: "passing",
      mergeable: null,
      prState: { state: "clean" },
      actions: { analysisOnly: false, requestCorrection: true },
      canEditReleaseNotes: true,
      onStaging: false,
    });
    expect(pr!.analysis).toMatchObject({
      status: "done",
      summary: "Tutto bene",
      risk: null,
      issues: [],
    });
  });

  it("la storia delle correzioni dal server (dalla più vecchia), «on staging» e owner/repo", async () => {
    const { api } = fakeApi({
      pulls: async () => ({
        items: [
          pull({
            repositoryFullName: "audin/audin-app",
            onStaging: true,
            correctionHistory: [
              {
                id: "c1",
                trigger: "auto",
                byId: null,
                state: "pushed",
                commitSha: null,
                why: "Fix test",
                at: "2026-11-13T09:10:00.000Z",
              },
              {
                id: "c2",
                trigger: "person",
                byId: "ada",
                state: "running",
                commitSha: null,
                why: "Rinomina",
                at: "2026-11-13T09:20:00.000Z",
              },
            ],
          }),
        ],
      }),
    });
    const [pr] = await createRealPrs(api, codeOf, release).listOpenPrs("p1");
    expect(pr).toMatchObject({ repo: "audin/audin-app", onStaging: true });
    expect(pr!.corrections.map((c) => [c.id, c.trigger, c.byId, c.state, c.why])).toEqual([
      ["c1", "auto", null, "pushed", "Fix test"],
      ["c2", "person", "ada", "running", "Rinomina"],
    ]);
  });

  it("una PR esterna è di un collega, senza task né autore inventato; i controlli illeggibili lo dicono", async () => {
    const { api } = fakeApi({
      pulls: async () => ({
        items: [pull({ origin: "external", checks: { status: "unknown", checks: [] } })],
      }),
    });
    const [pr] = await createRealPrs(api, codeOf, release).listOpenPrs("p1");
    expect(pr).toMatchObject({
      origin: "colleague",
      authorName: "",
      taskCode: null,
      checks: "unreadable",
    });
  });

  it("la coda: solo le PR pronte (per il server), e canMerge per quelle nella coda di rilascio", async () => {
    const { api } = fakeApi({
      pulls: async () => ({
        items: [pull(), pull({ prNumber: 247, ready: false }), pull({ prNumber: 248 })],
      }),
    });
    const queue = await createRealPrs(api, codeOf, release).listReleaseQueue("p1");
    expect(queue.map((q) => [q.number, q.canMerge])).toEqual([
      [246, true],
      [248, false],
    ]);
  });

  it("un progetto invisibile (404) non ha PR; la coda di chi non può fare merge (403) dà canMerge falso", async () => {
    const notFound = async () => {
      throw new ApiError(404, "not_found", "not_found");
    };
    const forbidden = async () => {
      throw new ApiError(403, "forbidden", "forbidden");
    };
    expect(
      await createRealPrs(fakeApi({ pulls: notFound }).api, codeOf, release).listOpenPrs("p1"),
    ).toEqual([]);
    const q = await createRealPrs(
      fakeApi({ queue: forbidden }).api,
      codeOf,
      release,
    ).listReleaseQueue("p1");
    expect(q.map((x) => x.canMerge)).toEqual([false]);
  });

  it("il merge: la rotta della PR (ticket e repository), il rilascio nato dal codice", async () => {
    const { api, calls } = fakeApi();
    const prs = createRealPrs(api, codeOf, release);
    const [pr] = await prs.listOpenPrs("p1");
    expect(await prs.mergePr(pr!.id)).toEqual({ ok: true, release: { code: "AUD-V7" } });
    expect(calls).toContain(`POST ${TICKET}/${REPO}/release`);
  });

  it("gli errori del merge nelle parole del prototipo; il 502 del provider è merge_failed", async () => {
    const failing = (status: number, code: string) =>
      createRealPrs(
        fakeApi({
          merge: async () => {
            throw new ApiError(status, code, code);
          },
        }).api,
        codeOf,
        release,
      );
    for (const [status, code, error] of [
      [403, "forbidden", "forbidden"],
      [409, "checks_failed", "checks_failed"],
      [409, "not_mergeable", "not_mergeable"],
      [502, "merge_failed", "merge_failed"],
    ] as const) {
      const prs = failing(status, code);
      const [pr] = await prs.listOpenPrs("p1");
      expect(await prs.mergePr(pr!.id)).toEqual({ ok: false, error });
    }
  });

  it("«Chiedi modifiche»: la nota alla rotta delle correzioni; gli errori nelle parole del prototipo", async () => {
    const { api, calls } = fakeApi();
    const prs = createRealPrs(api, codeOf, release);
    const [pr] = await prs.listOpenPrs("p1");
    expect(await prs.requestPrCorrection(pr!.id, "Rinomina il test")).toMatchObject({ ok: true });
    expect(calls).toContain(`POST ${TICKET}/${REPO}/corrections Rinomina il test`);
    for (const [code, error] of [
      ["correction_in_flight", "in_flight"],
      ["pr_not_open", "already_closed"],
      ["colleague_analysis_only", "analysis_only"],
    ] as const) {
      const failing = createRealPrs(
        fakeApi({
          requestCorrection: async () => {
            throw new ApiError(409, code, code);
          },
        }).api,
        codeOf,
        release,
      );
      const [p] = await failing.listOpenPrs("p1");
      expect(await failing.requestPrCorrection(p!.id, "x")).toEqual({ ok: false, error });
    }
  });

  it("«Solo analisi»: POST per accendere, DELETE per spegnere, e la PR riletta", async () => {
    const { api, calls } = fakeApi();
    const prs = createRealPrs(api, codeOf, release);
    const [pr] = await prs.listOpenPrs("p1");
    await prs.setPrAnalysisOnly(pr!.id, true);
    await prs.setPrAnalysisOnly(pr!.id, false);
    expect(calls).toContain(`POST ${REPO}/246/analysis-only`);
    expect(calls).toContain(`DELETE ${REPO}/246/analysis-only`);
  });

  it("le note della PR: lette dall'elenco, salvate con la PUT, la bozza dalla GET solo per chi le può scrivere", async () => {
    const { api, calls } = fakeApi({
      pulls: async () => ({ items: [pull({ releaseNotes: "- AUD-12: Checkout" } as never)] }),
    });
    const prs = createRealPrs(api, codeOf, release);
    const [pr] = await prs.listOpenPrs("p1");
    expect(pr!.releaseNotes).toBe("- AUD-12: Checkout");
    await prs.setPrReleaseNotes(pr!.id, "- AUD-12: Checkout nuovo");
    expect(calls).toContain(`PUT ${REPO}/246/release-notes - AUD-12: Checkout nuovo`);
    expect(await prs.releaseNotesDraft(pr!.id)).toEqual({
      text: "- AUD-12: Checkout",
      sources: ["AUD-12"],
    });
    const readOnly = createRealPrs(
      fakeApi({
        releaseNotes: async (repositoryId, prNumber) => ({
          repositoryId,
          prNumber,
          body: null,
          updatedById: null,
          updatedAt: null,
          draft: { text: "x", sources: [] },
          commitsRead: true,
          canEdit: false,
        }),
      }).api,
      codeOf,
      release,
    );
    const [p] = await readOnly.listOpenPrs("p1");
    expect(await readOnly.releaseNotesDraft(p!.id)).toBeNull();
  });

  it("la Home «Rilasci»: i falliti come rilasci, le pronte con canMerge e il loro progetto; una senza progetto si salta", async () => {
    const { api } = fakeApi();
    const fromRow = async (row: { code: string }) =>
      ({ code: row.code, projectCode: "AUD" }) as never;
    const mine = await createRealPrs(api, codeOf, release, fromRow).listMyReleases();
    expect(mine.failed).toEqual([{ code: "AUD-V3", projectCode: "AUD" }]);
    expect(mine.ready.map((q) => [q.number, q.projectId, q.canMerge, q.taskCode])).toEqual([
      [246, "p1", true, "AUD-12"],
    ]);
  });

  it("analysis_off: dell'istanza per una PR di Stubwise o di un repository acceso, del repository se è spento", async () => {
    const off = { state: "analysis_off" as const, autoRound: 0, canAutoCorrect: false };
    const { api } = fakeApi({
      pulls: async () => ({
        items: [
          pull({ prState: off, colleaguePrs: "analyze_only" }),
          pull({ prNumber: 300, origin: "external", prState: off, colleaguePrs: "off" }),
        ],
      }),
    });
    const prs = await createRealPrs(api, codeOf, release).listOpenPrs("p1");
    expect(prs.map((p) => p.analysisOff)).toEqual(["instance", "repository"]);
  });
});
