import { beforeEach, describe, expect, it } from "vitest";
import {
  archiveConversation,
  createConversation,
  getConversation,
  listConversations,
  renameConversation,
  resetApi,
  sendMessage,
  setLatency,
} from "./api";
import { setSessionPersonId } from "./session";

// Le letture che servono alla destinazione «Claude» (Task 6): archiviate
// dentro «Mine», chi aspetta chi, il titolo breve dopo la prima risposta.

beforeEach(() => {
  setLatency(0);
  resetApi();
});

const as = (personId: string) => setSessionPersonId(personId);
const ids = async (filter: Parameters<typeof listConversations>[0]) =>
  (await listConversations(filter)).map((r) => r.id);

describe("destinazione Claude: letture", () => {
  it("«Mine» esclude le archiviate; con `archived` mostra solo quelle", async () => {
    as("p-giulia");
    await archiveConversation("cv-giulia-week");
    expect(await ids({ scope: "mine" })).not.toContain("cv-giulia-week");
    const archived = await listConversations({ scope: "mine", archived: true });
    expect(archived.map((r) => r.id)).toContain("cv-giulia-week");
    expect(archived.every((r) => r.archived && r.ownerId === "p-giulia")).toBe(true);
  });

  it("`waitsOnViewer`: aspetta chi può rispondere o decidere, non chi guarda soltanto", async () => {
    const row = async (personId: string, id: string) => {
      as(personId);
      return (await listConversations({ scope: "live" })).find((r) => r.id === id);
    };
    // AUD-3: domanda aperta chiesta da Marco; risponde lui o chi ha `plans.approve`.
    expect((await row("p-marco", "cv-run-aud-3"))?.waitsOnViewer).toBe(true);
    expect((await row("p-laura", "cv-run-aud-3"))?.waitsOnViewer).toBe(true);
    // STW-13: piano da approvare; Marco (developer) lo guarda, Laura (lead) lo decide.
    expect((await row("p-marco", "cv-run-stw-13"))?.waitsOnViewer).toBe(false);
    expect((await row("p-laura", "cv-run-stw-13"))?.waitsOnViewer).toBe(true);
    // Una sessione al lavoro non aspetta nessuno.
    expect((await row("p-laura", "cv-run-stw-3"))?.waitsOnViewer).toBe(false);
  });

  it("la sessione della posta è solo del titolare, anche fra le concluse", async () => {
    as("p-giulia");
    expect(await ids({ scope: "finished", includeOlder: true })).toContain("cv-mail-giulia");
    as("p-roberta");
    expect(await ids({ scope: "finished", includeOlder: true })).not.toContain("cv-mail-giulia");
    expect(await ids({ scope: "finished", kind: "mail_classify", includeOlder: true })).toEqual(
      [],
    );
    expect(await getConversation("cv-mail-giulia")).toBeNull();
  });

  it("titolo automatico: la domanda accorciata, poi un titolo breve dopo la prima risposta", async () => {
    as("p-giulia");
    const c = await createConversation();
    await sendMessage(c.id, {
      text: "Could you tell me where my projects stand this week, and what slipped since Monday? Thanks",
    });
    expect((await getConversation(c.id))!.title).toBe(
      "Tell me where my projects stand this week…",
    );
    // Il secondo messaggio non lo cambia più.
    await sendMessage(c.id, { text: "Explain MKX-7" });
    expect((await getConversation(c.id))!.title).toBe(
      "Tell me where my projects stand this week…",
    );
  });

  it("un titolo rinominato prima della risposta resta quello scelto", async () => {
    as("p-giulia");
    const c = await createConversation();
    const sending = sendMessage(c.id, { text: "Can you explain MKX-7?" });
    await renameConversation(c.id, "Kitchen planner");
    await sending;
    expect((await getConversation(c.id))!.title).toBe("Kitchen planner");
  });

  it("una domanda corta resta com'è, senza convenevoli né punto di domanda", async () => {
    as("p-giulia");
    const c = await createConversation();
    await sendMessage(c.id, { text: "Can you explain MKX-7?" });
    expect((await getConversation(c.id))!.title).toBe("Explain MKX-7");
  });
});
