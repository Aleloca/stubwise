import { describe, expect, it } from "vitest";
import { actionsFor } from "./actions.js";
import { buildInboxBlocks, inboxBlockId, parseInboxBlockId } from "./slack-blocks.js";

/**
 * Test della composizione Block Kit del DM d'inbox. La forma dei blocchi è un
 * contratto con Slack (e con il Task 10, che rilegge `action_id`/`block_id`):
 * si asserisce sulla STRUTTURA, non su uno snapshot opaco.
 */

const NOTIFICATION_ID = "11111111-2222-3333-4444-555555555555";

/** Il blocco `actions` (il secondo), tipizzato quel tanto che basta ad asserire. */
function actionsBlock(blocks: unknown[]): {
  type: string;
  block_id: string;
  elements: {
    type: string;
    action_id: string;
    value?: string;
    url?: string;
    style?: string;
    text?: { text: string };
    options?: { value: string; text: { text: string } }[];
  }[];
} {
  return blocks[1] as ReturnType<typeof actionsBlock>;
}

/** Gli `action_id` degli elementi interattivi, nell'ordine. */
function actionIds(blocks: unknown[]): string[] {
  const block = blocks[1];
  if (!block) return [];
  return actionsBlock(blocks).elements.map((el) => el.action_id);
}

describe("buildInboxBlocks", () => {
  it("primo blocco: il testo mrkdwn della notifica, verbatim", () => {
    const blocks = buildInboxBlocks({
      text: "📝 Piano da approvare per *#42* — Titolo. <https://s.test/t/42|Ticket>",
      actions: ["open", "snooze", "handled"],
      notificationId: NOTIFICATION_ID,
      lang: "it",
    });
    expect(blocks[0]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "📝 Piano da approvare per *#42* — Titolo. <https://s.test/t/42|Ticket>",
      },
    });
  });

  it("le azioni dell'admin su un piano in attesa: approva (primary), rifiuta (danger), apri, snooze, gestita", () => {
    const actions = actionsFor(
      { kind: "job.plan_review", requestedByUserId: null },
      "awaiting_plan_approval",
      { id: "u1", role: "admin" },
    );
    const blocks = buildInboxBlocks({
      text: "Piano da approvare",
      actions,
      notificationId: NOTIFICATION_ID,
      url: "https://s.test/tickets/42",
      lang: "it",
    });

    expect(actionIds(blocks)).toEqual([
      "inbox:approve_plan",
      "inbox:reject_plan",
      "inbox:open",
      "inbox:snooze",
      "inbox:handled",
    ]);
    const els = actionsBlock(blocks).elements;
    expect(els[0]).toMatchObject({
      type: "button",
      style: "primary",
      value: NOTIFICATION_ID,
      text: { type: "plain_text", text: "Approva il piano" },
    });
    expect(els[1]).toMatchObject({ style: "danger", text: { text: "Rifiuta" } });
    // Il bottone link non ha `style` (non è una decisione) ma ha `url`.
    expect(els[2]).toMatchObject({ type: "button", url: "https://s.test/tickets/42" });
    expect(els[2]!.style).toBeUndefined();
    expect(els[4]).toMatchObject({ type: "button", text: { text: "Segna come gestita" } });
  });

  it("member sullo stesso evento: nessuna decisione nei bottoni", () => {
    const actions = actionsFor(
      { kind: "job.plan_review", requestedByUserId: null },
      "awaiting_plan_approval",
      { id: "u2", role: "member" },
    );
    const blocks = buildInboxBlocks({
      text: "Piano da approvare",
      actions,
      notificationId: NOTIFICATION_ID,
      url: "https://s.test/tickets/42",
      lang: "it",
    });
    expect(actionIds(blocks)).toEqual(["inbox:open", "inbox:snooze", "inbox:handled"]);
  });

  it("lo snooze è un menù con le tre durate, localizzate", () => {
    const blocks = buildInboxBlocks({
      text: "x",
      actions: ["open", "snooze", "handled"],
      notificationId: NOTIFICATION_ID,
      lang: "it",
    });
    const select = actionsBlock(blocks).elements.find((el) => el.action_id === "inbox:snooze")!;
    expect(select.type).toBe("static_select");
    expect(select.options?.map((o) => o.value)).toEqual(["1h", "tomorrow", "3d"]);
    expect(select.options?.map((o) => o.text.text)).toEqual(["1 ora", "Domani", "3 giorni"]);
  });

  it("in inglese le etichette cambiano, gli action_id no", () => {
    const en = buildInboxBlocks({
      text: "x",
      actions: ["approve_plan", "open", "snooze", "handled"],
      notificationId: NOTIFICATION_ID,
      url: "https://s.test/t/1",
      lang: "en",
    });
    const it = buildInboxBlocks({
      text: "x",
      actions: ["approve_plan", "open", "snooze", "handled"],
      notificationId: NOTIFICATION_ID,
      url: "https://s.test/t/1",
      lang: "it",
    });
    expect(actionIds(en)).toEqual(actionIds(it));
    const label = (blocks: unknown[], id: string): string | undefined =>
      actionsBlock(blocks).elements.find((el) => el.action_id === id)?.text?.text;
    expect(label(en, "inbox:approve_plan")).toBe("Approve plan");
    expect(label(en, "inbox:open")).toBe("Open");
    expect(label(it, "inbox:approve_plan")).toBe("Approva il piano");
  });

  it("senza url il bottone Apri non c'è (mai un link su `undefined`)", () => {
    const blocks = buildInboxBlocks({
      text: "x",
      actions: ["open", "snooze", "handled"],
      notificationId: NOTIFICATION_ID,
      lang: "en",
    });
    expect(actionIds(blocks)).toEqual(["inbox:snooze", "inbox:handled"]);
  });

  it("senza azioni interattive resta il solo testo (nessun blocco actions vuoto)", () => {
    const blocks = buildInboxBlocks({
      text: "✅ Gestita da alice@example.com",
      actions: [],
      notificationId: NOTIFICATION_ID,
      lang: "en",
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "section" });
  });

  it("il block_id porta il notificationId (unico carrier valido anche per il menù)", () => {
    const blocks = buildInboxBlocks({
      text: "x",
      actions: ["snooze"],
      notificationId: NOTIFICATION_ID,
      lang: "en",
    });
    expect(actionsBlock(blocks).block_id).toBe(`inbox:${NOTIFICATION_ID}`);
    expect(parseInboxBlockId(inboxBlockId(NOTIFICATION_ID))).toBe(NOTIFICATION_ID);
    expect(parseInboxBlockId("qualcos'altro")).toBeNull();
    expect(parseInboxBlockId(undefined)).toBeNull();
  });
});
