import { describe, expect, it } from "vitest";
import { actionsFor, type ActionId } from "./actions.js";
import { formatNotification, type NotificationEvent } from "./format.js";
import {
  buildInboxBlocks,
  buildQuestionBlocks,
  inboxBlockId,
  parseInboxBlockId,
} from "./slack-blocks.js";

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

/**
 * Test dei blocchi della DOMANDA dell'agente (`job.awaiting_input`): il DM ha
 * un bottone per opzione, costruito dal payload dell'evento — che è
 * autosufficiente e, essendo jsonb scritto da una versione qualsiasi, va
 * trattato come non fidato in entrambi i sensi (forma e contenuto).
 */
describe("buildQuestionBlocks", () => {
  const QUESTION_EVENT = {
    kind: "job.awaiting_input",
    ticketNumber: 7,
    ticketTitle: "Export CSV dello storico",
    projectName: "negozio-web",
    ticketUrl: "https://s.test/tickets/7",
    questionId: "99999999-8888-7777-6666-555555555555",
    round: 1,
    question: "Quali colonne deve avere il CSV?",
    options: [
      { label: "Colonne vecchie", consequence: "Gli export esistenti restano validi." },
      { label: "Colonne nuove", consequence: "Rompe gli script dei clienti." },
    ],
    recommendedIndex: 0,
    allowFreeText: true,
  };

  /** Blocchi con le azioni di chi PUÒ rispondere (richiedente o maintainer). */
  function questionBlocks(
    overrides: Partial<Record<string, unknown>> = {},
    opts: { lang?: "it" | "en"; actions?: ActionId[]; event?: unknown } = {},
  ): unknown[] {
    return buildQuestionBlocks({
      text: "❓ L'AI ha una domanda su *#7* — Export CSV. <https://s.test/tickets/7|Apri>",
      event: "event" in opts ? opts.event : { ...QUESTION_EVENT, ...overrides },
      actions: opts.actions ?? ["answer", "open", "snooze"],
      notificationId: NOTIFICATION_ID,
      url: "https://s.test/tickets/7",
      lang: opts.lang ?? "it",
    });
  }

  /** Il blocco `actions` (ovunque sia) e i suoi elementi. */
  function elementsOf(blocks: unknown[]): {
    type: string;
    action_id: string;
    text?: { text: string };
    value?: string;
  }[] {
    const block = blocks.find((b) => (b as { type?: string }).type === "actions") as
      | { elements: ReturnType<typeof elementsOf> }
      | undefined;
    return block?.elements ?? [];
  }

  function ids(blocks: unknown[]): string[] {
    return elementsOf(blocks).map((el) => el.action_id);
  }

  /** Testo mrkdwn della sezione delle opzioni (la seconda). */
  function optionsText(blocks: unknown[]): string {
    return (blocks[1] as { text: { text: string } }).text.text;
  }

  it("un bottone per opzione, poi Altro…, poi l'igiene dell'inbox", () => {
    const blocks = questionBlocks();
    expect(ids(blocks)).toEqual([
      "inbox:answer:0",
      "inbox:answer:1",
      "inbox:answer_free",
      "inbox:open",
      "inbox:snooze",
    ]);
    // Il block_id resta il carrier del notificationId, come per i DM standard.
    const actions = blocks.find((b) => (b as { type?: string }).type === "actions") as {
      block_id: string;
    };
    expect(actions.block_id).toBe(`inbox:${NOTIFICATION_ID}`);
    expect(elementsOf(blocks)[0]?.value).toBe(NOTIFICATION_ID);
  });

  it("il primo blocco resta il testo della notifica, il secondo elenca le opzioni con le conseguenze", () => {
    const blocks = questionBlocks();
    expect(blocks[0]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "❓ L'AI ha una domanda su *#7* — Export CSV. <https://s.test/tickets/7|Apri>",
      },
    });
    const text = optionsText(blocks);
    expect(text).toContain("1. *Colonne vecchie*");
    expect(text).toContain("Gli export esistenti restano validi.");
    expect(text).toContain("2. *Colonne nuove*");
    expect(text).toContain("Rompe gli script dei clienti.");
  });

  it("⭐ sulla raccomandata: sul bottone e nella sezione, che la nomina", () => {
    const blocks = questionBlocks({ recommendedIndex: 1 });
    const labels = elementsOf(blocks).map((el) => el.text?.text);
    expect(labels[0]).toBe("1. Colonne vecchie");
    expect(labels[1]).toBe("2. Colonne nuove ⭐");
    expect(optionsText(blocks)).toContain("2. *Colonne nuove* ⭐ _(consigliata)_");
    // Nessuna preselezione: la stella non è uno stile "primary" che invita al tap.
    expect(elementsOf(blocks)[1]).not.toHaveProperty("style");
  });

  it("in inglese cambiano le etichette, non gli action_id", () => {
    const it = questionBlocks({}, { lang: "it" });
    const en = questionBlocks({}, { lang: "en" });
    expect(ids(en)).toEqual(ids(it));
    const other = (blocks: unknown[]): string | undefined =>
      elementsOf(blocks).find((el) => el.action_id === "inbox:answer_free")?.text?.text;
    expect(other(it)).toBe("Altro…");
    expect(other(en)).toBe("Other…");
    expect(optionsText(en)).toContain("_(recommended)_");
  });

  it("senza testo libero non c'è il bottone Altro…", () => {
    const blocks = questionBlocks({ allowFreeText: false });
    expect(ids(blocks)).toEqual(["inbox:answer:0", "inbox:answer:1", "inbox:open", "inbox:snooze"]);
  });

  it("mai più di 4 opzioni (il contratto ne ammette 2–4): un payload gonfio viene tagliato", () => {
    const blocks = questionBlocks({
      options: Array.from({ length: 9 }, (_, i) => ({ label: `Opzione ${i + 1}` })),
    });
    expect(ids(blocks)).toEqual([
      "inbox:answer:0",
      "inbox:answer:1",
      "inbox:answer:2",
      "inbox:answer:3",
      "inbox:answer_free",
      "inbox:open",
      "inbox:snooze",
    ]);
  });

  it("un'etichetta lunghissima sta dentro i 75 caratteri del bottone", () => {
    const blocks = questionBlocks({
      options: [{ label: "A".repeat(400) }, { label: "B" }],
      recommendedIndex: 0,
    });
    const label = elementsOf(blocks)[0]!.text!.text;
    expect(label.length).toBeLessThanOrEqual(75);
    expect(label.startsWith("1. AAA")).toBe(true);
    expect(label.endsWith("… ⭐")).toBe(true);
  });

  it("la sezione delle opzioni sta dentro i 3000 caratteri della section", () => {
    const blocks = questionBlocks({
      options: Array.from({ length: 4 }, () => ({
        label: "Etichetta",
        consequence: "C".repeat(5000),
      })),
    });
    expect(optionsText(blocks).length).toBeLessThanOrEqual(3000);
  });

  it("testo dell'agente non fidato: nessun markup Slack iniettabile dalle etichette", () => {
    const blocks = questionBlocks({
      options: [
        { label: "<https://evil.test|Fidati di me>", consequence: "a & b <fine>" },
        { label: "Normale" },
      ],
    });
    const text = optionsText(blocks);
    expect(text).not.toContain("<https://evil.test|");
    expect(text).toContain("&lt;https://evil.test|Fidati di me&gt;");
    expect(text).toContain("a &amp; b &lt;fine&gt;");
  });

  it("percorso completo evento → testo → blocchi: ogni pezzo escapato UNA volta sola", () => {
    // La domanda passa da `formatNotification` (che la escapa nel testo), le
    // etichette da `buildQuestionBlocks`: due strade diverse per lo stesso
    // messaggio, e nessuna delle due deve ripassare sul lavoro dell'altra.
    const event = {
      ...QUESTION_EVENT,
      question: "Uso <https://evil.test|questo link> per A & B?",
      options: [
        { label: "Sì <b>", consequence: "Rompe A & B" },
        { label: "No", consequence: "Niente" },
      ],
    };
    const text = (formatNotification(event as NotificationEvent, "slack", "it").body as {
      text: string;
    }).text;
    // Blocchi costruiti sul testo VERO dell'evento, non su uno di comodo: è il
    // percorso che il poller percorre davvero.
    const blocks = buildQuestionBlocks({
      text,
      event,
      actions: ["answer", "open", "snooze"],
      notificationId: NOTIFICATION_ID,
      url: "https://s.test/tickets/7",
      lang: "it",
    });
    const rendered = JSON.stringify(blocks);

    // Domanda e etichette neutralizzate: nessun link iniettato da nessuna parte.
    expect(rendered).not.toContain("<https://evil.test|");
    expect(text).toContain("&lt;https://evil.test|questo link&gt;");
    // Il testo della notifica entra nel blocco VERBATIM (nessun secondo giro).
    expect((blocks[0] as { text: { text: string } }).text.text).toBe(text);
    expect(optionsText(blocks)).toContain("Sì &lt;b&gt;");
    expect(optionsText(blocks)).toContain("Rompe A &amp; B");
    // Nessuna entità doppia in tutto il messaggio.
    expect(rendered).not.toContain("&amp;amp;");
    expect(rendered).not.toContain("&amp;lt;");
    // Il markup NOSTRO resta vivo: riferimento al ticket e link "Apri".
    expect(rendered).toContain("*#7*");
    expect(rendered).toContain("https://s.test/tickets/7|Apri");
  });

  it("job ripartito (niente `answer` fra le azioni) → blocchi standard, nessun bottone di risposta", () => {
    const blocks = questionBlocks({}, { actions: ["open", "snooze"] });
    expect(ids(blocks)).toEqual(["inbox:open", "inbox:snooze"]);
    expect(blocks).toHaveLength(2);
  });

  it("payload marcio → blocchi standard senza `answer` (mai un bottone che non può rispondere)", () => {
    for (const event of [
      null,
      { kind: "job.awaiting_input" },
      { ...QUESTION_EVENT, options: "non un array", allowFreeText: false },
      { ...QUESTION_EVENT, options: [{ label: "  " }], allowFreeText: false },
    ]) {
      const blocks = questionBlocks({}, { event });
      expect(ids(blocks)).toEqual(["inbox:open", "inbox:snooze"]);
    }
  });

  it("payload senza opzioni ma con testo libero: resta il solo Altro…", () => {
    const blocks = questionBlocks({ options: [], recommendedIndex: undefined });
    expect(ids(blocks)).toEqual(["inbox:answer_free", "inbox:open", "inbox:snooze"]);
  });
});
