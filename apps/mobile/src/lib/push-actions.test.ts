import { ApiError } from "@stubwise/api-client";
import type { StubwiseClient } from "@stubwise/api-client";
import { Linking } from "react-native";
import { categoryFor, handlePushAction } from "./push-actions";

jest.mock("react-native", () => ({ Linking: { openURL: jest.fn() } }));

const mockOpenURL = Linking.openURL as jest.Mock;

/** Client fittizio: solo i metodi che `handlePushAction` può chiamare. */
function fakeClient(overrides: Partial<StubwiseClient["inbox"]> = {}): StubwiseClient {
  return {
    inbox: {
      snooze: jest.fn(),
      act: jest.fn(),
      answer: jest.fn(),
      list: jest.fn(),
      ...overrides,
    },
  } as unknown as StubwiseClient;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("categoryFor", () => {
  test("job.awaiting_input → Rispondi / Rimanda 1h", () => {
    expect(categoryFor("job.awaiting_input").actions.map((a) => a.id)).toEqual(["answer", "snooze_1h"]);
  });

  test("job.plan_review → Approva / Rifiuta… / Rimanda 1h", () => {
    expect(categoryFor("job.plan_review").actions.map((a) => a.id)).toEqual(["approve", "reject", "snooze_1h"]);
  });

  test("project.pulse → Procedi con la consigliata / Apri", () => {
    expect(categoryFor("project.pulse").actions.map((a) => a.id)).toEqual(["proceed", "open"]);
  });

  test("job.failed e job.held → Riprova / Apri", () => {
    expect(categoryFor("job.failed").actions.map((a) => a.id)).toEqual(["relaunch", "open"]);
    expect(categoryFor("job.held").actions.map((a) => a.id)).toEqual(["relaunch", "open"]);
  });

  test("un kind senza azioni dichiarate degrada alla categoria di riserva (solo Apri)", () => {
    expect(categoryFor("ticket.created").actions.map((a) => a.id)).toEqual(["open"]);
  });

  test("un kind sconosciuto (mai visto da questa build) degrada allo stesso modo", () => {
    expect(categoryFor("some.future.kind").actions.map((a) => a.id)).toEqual(["open"]);
  });
});

describe("handlePushAction", () => {
  test("Rimanda 1h → snooze(id, '1h')", async () => {
    const client = fakeClient();
    await handlePushAction({ kind: "job.awaiting_input", notificationId: "n1", actionId: "snooze_1h" }, client);
    expect(client.inbox.snooze).toHaveBeenCalledWith("n1", "1h");
    expect(mockOpenURL).not.toHaveBeenCalled();
  });

  test("Approva → act(id, 'approve_plan') chiamato", async () => {
    const client = fakeClient();
    await handlePushAction({ kind: "job.plan_review", notificationId: "n2", actionId: "approve" }, client);
    expect(client.inbox.act).toHaveBeenCalledWith("n2", "approve_plan");
    expect(mockOpenURL).not.toHaveBeenCalled();
  });

  test("Riprova → act(id, 'relaunch') chiamato", async () => {
    const client = fakeClient();
    await handlePushAction({ kind: "job.failed", notificationId: "n3", actionId: "relaunch" }, client);
    expect(client.inbox.act).toHaveBeenCalledWith("n3", "relaunch");
    expect(mockOpenURL).not.toHaveBeenCalled();
  });

  test("Rifiuta… → apre l'app SENZA chiamare nessuna rotta (mai reject dalla notifica)", async () => {
    const client = fakeClient();
    await handlePushAction({ kind: "job.plan_review", notificationId: "n4", actionId: "reject" }, client);
    expect(mockOpenURL).toHaveBeenCalledWith("stubwise://inbox/n4");
    expect(client.inbox.act).not.toHaveBeenCalled();
    expect(client.inbox.snooze).not.toHaveBeenCalled();
    expect(client.inbox.answer).not.toHaveBeenCalled();
  });

  test("Rispondi → apre l'app SENZA chiamare answer (mai testo libero dalla notifica)", async () => {
    const client = fakeClient();
    await handlePushAction({ kind: "job.awaiting_input", notificationId: "n5", actionId: "answer" }, client);
    expect(mockOpenURL).toHaveBeenCalledWith("stubwise://inbox/n5");
    expect(client.inbox.answer).not.toHaveBeenCalled();
  });

  test("Apri (default, o un kind senza azioni) → apre l'app senza chiamare nulla", async () => {
    const client = fakeClient();
    await handlePushAction({ kind: "ticket.created", notificationId: "n6", actionId: "open" }, client);
    expect(mockOpenURL).toHaveBeenCalledWith("stubwise://inbox/n6");
    expect(client.inbox.act).not.toHaveBeenCalled();
  });

  test("un actionId sconosciuto degrada ad aprire l'app (mai un'eccezione)", async () => {
    const client = fakeClient();
    await handlePushAction({ kind: "job.plan_review", notificationId: "n7", actionId: "qualcosa_di_ignoto" }, client);
    expect(mockOpenURL).toHaveBeenCalledWith("stubwise://inbox/n7");
  });

  test("Procedi (pulse) → legge recommendedIndex dall'inbox aperta ed esegue answer con quello", async () => {
    const client = fakeClient({
      list: jest.fn().mockResolvedValue({
        items: [
          { id: "other", question: { recommendedIndex: 9 } },
          { id: "n8", question: { recommendedIndex: 2 } },
        ],
        nextCursor: null,
      }),
    });
    await handlePushAction({ kind: "project.pulse", notificationId: "n8", actionId: "proceed" }, client);
    expect(client.inbox.answer).toHaveBeenCalledWith("n8", { optionIndex: 2 });
    expect(mockOpenURL).not.toHaveBeenCalled();
  });

  test("Procedi (pulse) senza la notifica più nell'inbox aperta → apre l'app, nessun answer", async () => {
    const client = fakeClient({
      list: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    });
    await handlePushAction({ kind: "project.pulse", notificationId: "n9", actionId: "proceed" }, client);
    expect(client.inbox.answer).not.toHaveBeenCalled();
    expect(mockOpenURL).toHaveBeenCalledWith("stubwise://inbox/n9");
  });

  test("409 (qualcun altro ha già deciso) → apre l'app sulla card informativa", async () => {
    const client = fakeClient({
      act: jest.fn().mockRejectedValue(new ApiError(409, "Already handled by a@b.it", "already_handled")),
    });
    await handlePushAction({ kind: "job.plan_review", notificationId: "n10", actionId: "approve" }, client);
    expect(mockOpenURL).toHaveBeenCalledWith("stubwise://inbox/n10");
  });

  test("un errore di rete sull'azione → apre comunque l'app (nessun catch vuoto)", async () => {
    const client = fakeClient({
      snooze: jest.fn().mockRejectedValue(new TypeError("Network request failed")),
    });
    await handlePushAction({ kind: "job.awaiting_input", notificationId: "n11", actionId: "snooze_1h" }, client);
    expect(mockOpenURL).toHaveBeenCalledWith("stubwise://inbox/n11");
  });
});
