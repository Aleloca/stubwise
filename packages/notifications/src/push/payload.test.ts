import {
  languageSchema,
  PUSH_BODY_MAX_CHARS,
  pushRelaySendRequestSchema,
  type Language,
} from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { formatNotificationText, sampleEvents, type NotificationEvent } from "../format.js";
import { buildPushPayload, PUSH_TITLE_KEY, type PushPayloadContext } from "./payload.js";

const BASE_URL = "https://stubwise.test";
const NOTIFICATION_ID = "3f2a91c4-5555-4666-8777-888899990000";
const PROJECT_ID = "2e5a8c4b-9999-4aaa-8bbb-ccccddddeeee";
// Legato all'enum e non scritto a mano: una lingua nuova deve far girare
// questi test su di essa, non restare fuori copertura in silenzio.
const LANGS: Language[] = [...languageSchema.options];

/** Lo schema del solo `payload`, come lo vede il relay. */
const payloadSchema = pushRelaySendRequestSchema.shape.payload;

const EVENTS = sampleEvents(BASE_URL);

function build(event: NotificationEvent, lang: Language, extra: Partial<PushPayloadContext> = {}) {
  return buildPushPayload(event, lang, {
    notificationId: NOTIFICATION_ID,
    unreadCount: 3,
    ...extra,
  });
}

describe("buildPushPayload", () => {
  it("copre TUTTI i kind: `sampleEvents` non è una lista scritta a mano", () => {
    // `routing.test.ts` verifica già che `sampleEvents` combaci esattamente con
    // l'enum Postgres `notification_kind`: iterarlo qui vuol dire iterare i kind
    // veri, e un kind aggiunto domani entra in questi controlli da solo.
    expect(EVENTS.length).toBeGreaterThanOrEqual(13);
    expect(Object.keys(PUSH_TITLE_KEY).sort()).toEqual([...EVENTS.map((e) => e.kind)].sort());
  });

  describe.each(EVENTS.map((event) => ({ kind: event.kind, event })))("$kind", ({ event }) => {
    it.each(LANGS)("in %s ha titolo, corpo e ancore all'inbox", (lang) => {
      const payload = build(event, lang);

      // Un titolo VUOTO non è l'unico modo di sbagliare: `t()` ritorna la
      // CHIAVE quando manca dal catalogo, quindi "non vuoto" passerebbe anche
      // su una chiave inesistente. Si controlla che non sia la chiave.
      expect(payload.title).not.toBe("");
      expect(payload.title).not.toBe(PUSH_TITLE_KEY[event.kind]);
      // …e che nessun segnaposto sia rimasto da interpolare.
      expect(payload.title).not.toMatch(/\{\w+\}/);

      expect(payload.category).toBe(event.kind);
      expect(payload.body).toBe(formatNotificationText(event, lang));
      expect(payload.data).toEqual({
        notificationId: NOTIFICATION_ID,
        kind: event.kind,
        deepLink: `stubwise://inbox/${NOTIFICATION_ID}`,
      });
      expect(payload.collapseId).toBe(NOTIFICATION_ID);
      expect(payload.badge).toBe(3);
      expect(payloadSchema.safeParse(payload).success).toBe(true);
    });

    it("il titolo italiano non è quello inglese (nessun fallback silenzioso)", () => {
      // `t()` fa fallback su `en` quando la chiave manca in `it`: una
      // traduzione dimenticata darebbe un titolo inglese su un telefono
      // italiano senza che nulla protesti. Questo test e quello sul
      // `title !== chiave` qui sopra coprono insieme i due modi di sbagliare —
      // chiave assente da un catalogo, o da entrambi.
      expect(build(event, "it").title).not.toBe(build(event, "en").title);
    });
  });

  it("il pulse nomina il progetto nel titolo", () => {
    const pulse = EVENTS.find((event) => event.kind === "project.pulse")!;
    expect(build(pulse, "it").title).toContain("negozio-web");
    expect(build(pulse, "en").title).toContain("negozio-web");
  });

  it("threadId è il progetto, e manca quando la notifica non ne ha uno", () => {
    const event = EVENTS[0]!;
    expect(build(event, "it", { projectId: PROJECT_ID }).threadId).toBe(PROJECT_ID);
    expect(build(event, "it")).not.toHaveProperty("threadId");
    expect(build(event, "it", { projectId: null })).not.toHaveProperty("threadId");
  });

  it("il badge è il non-letto del destinatario, zero compreso", () => {
    expect(build(EVENTS[0]!, "it", { unreadCount: 0 }).badge).toBe(0);
  });
});

describe("tetto del payload", () => {
  /** Un `job.failed` col messaggio d'errore lunghissimo: succede davvero. */
  function longFailure(error: string): NotificationEvent {
    return {
      kind: "job.failed",
      ticketNumber: 129,
      ticketTitle: "Pagamento non confermato dopo il redirect",
      projectName: "negozio-web",
      error,
      ticketUrl: `${BASE_URL}/tickets/129`,
    };
  }

  it("tronca un corpo enorme invece di far rifiutare la push da APNs", () => {
    // Oltre 4096 byte APNs risponde `PayloadTooLarge`: il relay tornerebbe
    // `retry`, il poller ritenterebbe, e la push non arriverebbe MAI. Il tetto
    // lo fa rispettare chi costruisce il payload, non chi lo spedisce.
    const payload = build(longFailure("stack trace ".repeat(2000)), "it");
    expect(payload.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX_CHARS);
    expect(payload.body.endsWith("…")).toBe(true);
    expect(payloadSchema.safeParse(payload).success).toBe(true);
  });

  it("tronca sui CODE POINT: niente surrogati spaiati in un corpo di emoji", () => {
    // `slice()` taglia sulle unità UTF-16 e può spezzare una coppia surrogata,
    // producendo un carattere che non è UTF-8 valido — cioè un body che il
    // relay o APNs rifiutano su un contenuto perfettamente legittimo. Le emoji
    // sono il caso reale: un titolo di ticket ne è pieno.
    const payload = build(longFailure("🙈".repeat(2000)), "it");
    const lone = [...payload.body].filter((char) => {
      const code = char.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    });
    expect(lone).toEqual([]);
    expect(payload.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX_CHARS);
    expect(payloadSchema.safeParse(payload).success).toBe(true);
  });

  it("non spezza una FAMIGLIA ZWJ: niente padre con uno ZWJ penzolante", () => {
    // `👨‍👩‍👧` è un solo grafema fatto di cinque code point tenuti insieme
    // da due ZWJ. Tagliare sui code point produce UTF-8 validissimo — quindi
    // nessun test sui byte se ne accorge — e sulla lock screen si vede un
    // padre solo, o uno ZWJ appeso all'ellissi.
    const payload = build(longFailure("👨‍👩‍👧".repeat(200)), "it");
    const body = payload.body.slice(0, -1);
    expect(body.endsWith("\u200d")).toBe(false);
    // Ogni ZWJ del corpo deve stare FRA due caratteri, mai in fondo.
    expect(/\u200d$/.test(body)).toBe(false);
    // …e i grafemi rimasti devono essere famiglie intere: due ZWJ ciascuna.
    const zwj = [...body].filter((char) => char === "\u200d").length;
    const persons = [...body].filter((char) => "👨👩👧".includes(char)).length;
    expect(zwj).toBe(persons - persons / 3);
    expect(payload.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX_CHARS);
  });

  it("non spezza una BANDIERA: i regional indicator restano in coppia", () => {
    // `🇮🇹` sono DUE regional indicator: mezzo grafema si vede come una «I»
    // dentro un riquadro, che è esattamente ciò che l'utente non deve leggere.
    const payload = build(longFailure("🇮🇹".repeat(400)), "it");
    const indicators = [...payload.body].filter((char) => {
      const code = char.codePointAt(0)!;
      return code >= 0x1f1e6 && code <= 0x1f1ff;
    }).length;
    expect(indicators % 2).toBe(0);
    expect(payload.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX_CHARS);
  });

  it("un corpo che ci sta non viene toccato", () => {
    const event = longFailure("test suite fallita (3 test rossi)");
    expect(build(event, "it").body).toBe(formatNotificationText(event, "it"));
  });
});
