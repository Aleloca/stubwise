import type { PrCycle, Reader, TicketRepository } from "@stubwise/shared";
import { readerSchema, ticketRepositorySchema } from "@stubwise/shared";
import { parseTicketTab, statusNeedsViewer, TICKET_TABS, ticketTabForKind } from "./ticket-tabs";

/**
 * La pagina del ticket a tab (2 ott 2026, piano Task 4): quale tab si apre,
 * e quando la tab Stato chiede un'azione a chi guarda (il pallino). Funzioni
 * pure, nessun React. Fixture COMPLETE (CLAUDE.md, la trappola delle fixture
 * dell'app); il caso «server vecchio» passa da `readerSchema`, come in
 * produzione.
 */

const HELD_JOB_ID = "11111111-1111-4111-8111-111111111111";
const REPO_ID = "22222222-2222-4222-8222-222222222222";

function cycle(overrides: Partial<Reader<PrCycle>> = {}): Reader<PrCycle> {
  return {
    state: "idle",
    round: 0,
    maxRounds: 3,
    pendingRequest: false,
    lastRequest: null,
    canRequestCorrection: true,
    heldReason: null,
    canResume: false,
    heldJobId: null,
    blockedReason: null,
    ...overrides,
  };
}

function repo(overrides: Partial<Reader<TicketRepository>> = {}): Reader<TicketRepository> {
  return {
    repositoryId: REPO_ID,
    repositorySlug: "stubwise-test",
    repositoryName: "stubwise-test",
    branch: "stubwise/ticket-1",
    prUrl: "https://bitbucket.org/acme/stubwise-test/pull-requests/4",
    prState: "open",
    cycle: cycle(),
    ...overrides,
  };
}

const NOTHING = { hasOpenQuestion: false, canAnswer: false, canDecide: false };

const needs = (overrides: Partial<Parameters<typeof statusNeedsViewer>[0]>) =>
  statusNeedsViewer({ ...NOTHING, repositories: [], ...overrides });

describe("parseTicketTab", () => {
  it.each(TICKET_TABS)("%s → se stesso", (tab) => {
    expect(parseTicketTab(tab)).toBe(tab);
  });

  it.each([
    ["assente", undefined],
    ["sconosciuto", "foo"],
    ["un numero", 42],
    ["null", null],
  ])("%s → status", (_name, value) => {
    expect(parseTicketTab(value)).toBe("status");
  });

  it("le tab sono quattro, in quest'ordine", () => {
    expect(TICKET_TABS).toEqual(["status", "content", "activity", "details"]);
  });
});

describe("statusNeedsViewer: il pallino di Stato", () => {
  describe("vero", () => {
    it("una domanda dell'AI che chi guarda può rispondere", () => {
      expect(needs({ hasOpenQuestion: true, canAnswer: true })).toBe(true);
    });

    it("un piano da approvare che chi guarda può decidere", () => {
      expect(needs({ canDecide: true })).toBe(true);
    });

    it.each(["stopped_at_cap", "correction_failed", "changes_requested"] as const)(
      "%s su PR aperta, con «Chiedi modifiche» acceso",
      (state) => {
        expect(needs({ repositories: [repo({ cycle: cycle({ state, round: 3 }) })] })).toBe(true);
      },
    );

    it("correzione ferma per budget, con «Riprendi» offerto", () => {
      const c = cycle({ state: "correcting", heldReason: "budget", canResume: true, heldJobId: HELD_JOB_ID, canRequestCorrection: false });
      expect(needs({ repositories: [repo({ cycle: c })] })).toBe(true);
    });

    it("correzione ferma per un altro motivo (`other`), con «Riprendi» offerto", () => {
      const c = cycle({ state: "correcting", heldReason: "other", canResume: true, heldJobId: HELD_JOB_ID, canRequestCorrection: false });
      expect(needs({ repositories: [repo({ cycle: c })] })).toBe(true);
    });

    it("basta UNA PR che chiede: le altre tranquille non spengono il pallino", () => {
      expect(
        needs({
          repositories: [
            repo({ cycle: cycle({ state: "approved" }) }),
            repo({ repositoryId: "33333333-3333-4333-8333-333333333333", cycle: cycle({ state: "stopped_at_cap", round: 3 }) }),
          ],
        }),
      ).toBe(true);
    });
  });

  describe("falso", () => {
    it("niente da fare", () => {
      expect(needs({ repositories: [repo({ cycle: cycle({ state: "reviewing" }) })] })).toBe(false);
    });

    it("una domanda aperta che chi guarda NON può rispondere", () => {
      expect(needs({ hasOpenQuestion: true, canAnswer: false })).toBe(false);
    });

    it("ferma per il LIMITE del provider, anche con `canResume`: riparte da sola", () => {
      const c = cycle({ state: "correcting", heldReason: "limit", canResume: true, heldJobId: HELD_JOB_ID, canRequestCorrection: false });
      expect(needs({ repositories: [repo({ cycle: c })] })).toBe(false);
    });

    it("`canResume` senza `heldJobId`: «Riprendi» non si offre", () => {
      const c = cycle({ state: "correcting", heldReason: "budget", canResume: true, heldJobId: null, canRequestCorrection: false });
      expect(needs({ repositories: [repo({ cycle: c })] })).toBe(false);
    });

    it("ferma per budget e chi guarda NON la può riprendere", () => {
      const c = cycle({ state: "correcting", heldReason: "budget", canResume: false, heldJobId: HELD_JOB_ID, canRequestCorrection: false });
      expect(needs({ repositories: [repo({ cycle: c })] })).toBe(false);
    });

    it("stopped_at_cap col bottone SPENTO (`canRequestCorrection: false`, es. un job in volo)", () => {
      expect(
        needs({ repositories: [repo({ cycle: cycle({ state: "stopped_at_cap", round: 3, canRequestCorrection: false }) })] }),
      ).toBe(false);
    });

    it("stopped_at_cap su una PR già mergiata: niente da chiedere", () => {
      expect(needs({ repositories: [repo({ prState: "merged", cycle: cycle({ state: "stopped_at_cap", round: 3 }) })] })).toBe(
        false,
      );
    });

    it("approvata dalla review", () => {
      expect(needs({ repositories: [repo({ cycle: cycle({ state: "approved" }) })] })).toBe(false);
    });

    it("`cycle: null` (PR non di Stubwise)", () => {
      expect(needs({ repositories: [repo({ cycle: null })] })).toBe(false);
    });

    it("nessuna PR ancora", () => {
      expect(needs({ repositories: [repo({ prUrl: null, cycle: null })] })).toBe(false);
    });

    it("ciclo da server vecchio (senza heldReason/canResume/heldJobId, parsato): «Riprendi» non si offre", () => {
      const old = readerSchema(ticketRepositorySchema).parse({
        repositoryId: REPO_ID,
        repositorySlug: "stubwise-test",
        branch: "stubwise/ticket-1",
        prUrl: "https://bitbucket.org/acme/stubwise-test/pull-requests/4",
        prState: "open",
        cycle: {
          state: "correcting",
          round: 1,
          maxRounds: 3,
          pendingRequest: false,
          lastRequest: null,
          canRequestCorrection: false,
        },
      });
      expect(old.cycle?.canResume).toBe(false);
      expect(needs({ repositories: [old] })).toBe(false);
    });

    it("un server ancora più vecchio, senza `cycle` per niente (parsato): tace", () => {
      const old = readerSchema(ticketRepositorySchema).parse({
        repositoryId: REPO_ID,
        repositorySlug: "stubwise-test",
        branch: "stubwise/ticket-1",
        prUrl: "https://bitbucket.org/acme/stubwise-test/pull-requests/4",
        prState: "open",
      });
      expect(old.cycle).toBeNull();
      expect(needs({ repositories: [old] })).toBe(false);
    });
  });
});

describe("ticketTabForKind", () => {
  it.each([
    "job.awaiting_input",
    "job.plan_review",
    "review.completed",
    "job.pr_opened",
    "job.failed",
    "job.held",
    "job.budget_held",
    "job.pr_closed",
    "ticket.created",
  ])("%s → status", (kind) => {
    expect(ticketTabForKind(kind)).toBe("status");
  });

  it("un kind sconosciuto → status", () => {
    expect(ticketTabForKind("kind.futuro")).toBe("status");
  });

  it("nessuna notifica porta ad Attività (non esiste un kind per i commenti)", () => {
    const kinds = [
      "ticket.created",
      "job.pr_opened",
      "job.pr_closed",
      "job.held",
      "job.plan_review",
      "job.budget_held",
      "review.completed",
      "job.failed",
      "job.awaiting_input",
    ];
    expect(kinds.filter((kind) => ticketTabForKind(kind) === "activity")).toEqual([]);
  });
});
