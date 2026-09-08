import { describe, expect, it } from "vitest";
import {
  deviceDeletionSchema,
  deviceRegistrationSchema,
  inboxGoogleSchema,
  inboxItemSchema,
  inboxQuestionSchema,
  ticketQuestionSchema,
} from "./notification.js";

/**
 * `round` è l'unico campo della domanda che NON è generalizzabile ai kind con
 * opzioni: nasce dai giri di `ask_user` su uno stesso job, e il pulse proattivo
 * — che di job non ne ha — non ne ha uno. Questi test tengono ferma
 * l'asimmetria voluta: opzionale sulla card d'inbox, obbligatorio sulla pagina
 * ticket (dove la colonna `agent_questions.round` esiste sempre).
 */
describe("inboxQuestionSchema — round opzionale", () => {
  const base = {
    questionId: "1c9e4f70-5555-4666-8777-888899990000",
    question: "Da quale proposta partiamo?",
    options: [{ label: "Export CSV" }],
    allowFreeText: false,
  };

  it("accetta una domanda SENZA round (è la forma del pulse)", () => {
    const parsed = inboxQuestionSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && "round" in parsed.data).toBe(false);
  });

  it("accetta e conserva il round quando c'è (domanda dell'agente)", () => {
    const parsed = inboxQuestionSchema.safeParse({ ...base, round: 2 });
    expect(parsed.success && parsed.data.round).toBe(2);
  });

  it("un round non intero resta un errore: opzionale non vuol dire libero", () => {
    expect(inboxQuestionSchema.safeParse({ ...base, round: 1.5 }).success).toBe(false);
  });
});

describe("ticketQuestionSchema — round di nuovo obbligatorio", () => {
  const domandaDiTicket = {
    questionId: "1c9e4f70-5555-4666-8777-888899990000",
    question: "Quali colonne deve avere il CSV?",
    options: [{ label: "Colonne vecchie" }, { label: "Colonne nuove" }],
    allowFreeText: true,
    jobId: "aa11bb22-1111-4222-8333-444455556666",
    askedAt: "2026-09-01T10:00:00.000Z",
    answer: null,
    answeredAt: null,
    answeredBy: null,
  };

  it("senza round NON passa: sulla pagina ticket la colonna c'è sempre", () => {
    expect(ticketQuestionSchema.safeParse(domandaDiTicket).success).toBe(false);
    expect(ticketQuestionSchema.safeParse({ ...domandaDiTicket, round: 1 }).success).toBe(true);
  });
});

/**
 * Gli schemi dei device push: qui si sorvegliano le due scelte che nel resto
 * del codice sono solo commenti — il tetto in BYTE e lo strip (voluto) del
 * campo sconosciuto.
 */
/**
 * Il blocco `google` è il campo NUOVO della fase 6 su una risposta che l'app
 * mobile legge già (`GET /api/inbox`). L'invariante «solo cambi additivi» dice
 * che deve nascere opzionale, e la ragione non è ovvia: «aggiungere un campo è
 * sicuro» vale per il client VECCHIO che ne riceve uno in più, non per il
 * client NUOVO che ne riceve uno in meno da un server più vecchio (un
 * rollback, un'istanza self-hosted non aggiornata) — e l'app è UNA per tutte.
 */
describe("inboxItemSchema — il blocco google è additivo", () => {
  const item = {
    id: "1c9e4f70-5555-4666-8777-888899990000",
    kind: "google.proposal",
    status: "open",
    text: "Nuova proposta da laura@cliente.test — Export ordini.",
    actions: ["answer", "open", "snooze", "handled"],
    projectId: null,
    ticketId: null,
    jobId: null,
    createdAt: "2026-09-07T08:14:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
  };

  const google = {
    source: "email",
    from: "laura@cliente.test",
    subject: "Export degli ordini",
    receivedAt: "2026-09-07T08:14:00.000Z",
    signal: "request",
    actions: [{ type: "create_backlog_item" }, { type: "ignore" }],
  };

  it("parsa un item SENZA il blocco (server più vecchio, o kind che non ne ha)", () => {
    const parsed = inboxItemSchema.safeParse(item);
    expect(parsed.success).toBe(true);
    expect(parsed.success && "google" in parsed.data).toBe(false);
  });

  it("parsa e conserva il blocco quando c'è", () => {
    const parsed = inboxItemSchema.safeParse({ ...item, google });
    expect(parsed.success && parsed.data.google?.source).toBe("email");
    expect(parsed.success && parsed.data.google?.actions).toEqual([
      { type: "create_backlog_item" },
      { type: "ignore" },
    ]);
  });

  it("delle azioni tiene SOLO il tipo: il payload non esce dal server", () => {
    // Se `projectId`/`title` uscissero, una superficie potrebbe rimandarli
    // modificati e la conferma non sarebbe più «esegui la proposta che hai
    // letto». Lo strip di `z.object` è la difesa, ed è qui che si vede.
    const parsed = inboxGoogleSchema.safeParse({
      ...google,
      actions: [{ type: "create_backlog_item", projectId: "p1", title: "iniettato" }],
    });
    expect(parsed.success && parsed.data.actions).toEqual([{ type: "create_backlog_item" }]);
  });

  it("una data illeggibile costa il campo, non l'intero blocco", () => {
    const parsed = inboxGoogleSchema.safeParse({ ...google, receivedAt: "ieri mattina" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.receivedAt).toBeUndefined();
    expect(parsed.success && parsed.data.subject).toBe("Export degli ordini");
  });

  it("un tipo d'azione sconosciuto invalida il blocco (la card degrada)", () => {
    // Meglio nessun contorno che un contorno che dice «esegui qualcosa» senza
    // saper dire cosa: chi legge omette il blocco e la card resta confermabile.
    expect(
      inboxGoogleSchema.safeParse({ ...google, actions: [{ type: "svuota_il_backlog" }] }).success,
    ).toBe(false);
  });
});

describe("deviceRegistrationSchema", () => {
  const valido = { platform: "ios" as const, token: "tok-1" };

  it("appVersion è opzionale, e i campi che contano no", () => {
    expect(deviceRegistrationSchema.safeParse(valido).success).toBe(true);
    expect(deviceRegistrationSchema.safeParse({ platform: "ios" }).success).toBe(false);
    expect(deviceRegistrationSchema.safeParse({ token: "tok-1" }).success).toBe(false);
  });

  it("una piattaforma fuori lista non passa", () => {
    expect(deviceRegistrationSchema.safeParse({ ...valido, platform: "web" }).success).toBe(false);
  });

  it("STRIPPA un campo sconosciuto invece di rifiutarlo, al contrario delle prefs", () => {
    // È l'asimmetria deliberata con `notificationPrefsUpdateSchema`, che è
    // `.strict()`: là tutti i campi sono opzionali e uno strip trasformerebbe
    // un typo in un 204 bugiardo. Qui i campi che contano sono obbligatori
    // (un typo su `platform` o `token` resta un errore), e lo strip serve a
    // non rispondere 400 a un'app più NUOVA del server, che manda un campo
    // che ancora non conosciamo.
    const esito = deviceRegistrationSchema.safeParse({ ...valido, campoDelFuturo: 1 });
    expect(esito.success).toBe(true);
    expect(esito.data).not.toHaveProperty("campoDelFuturo");
  });

  it("il tetto del token è in BYTE, non in caratteri", () => {
    // 1024 caratteri ASCII = 1024 byte: dentro. Gli stessi 1024 caratteri in
    // CJK sono 3072 byte: fuori, benché `.length` sia identico. Senza il
    // controllo sui byte il secondo caso passerebbe e morirebbe in DB, dove
    // la voce d'indice btree si ferma a 2704 byte.
    const ascii = "a".repeat(1024);
    const cjk = "\u4e2d".repeat(1024);
    expect(ascii.length).toBe(cjk.length);
    expect(deviceRegistrationSchema.safeParse({ ...valido, token: ascii }).success).toBe(true);
    expect(deviceRegistrationSchema.safeParse({ ...valido, token: cjk }).success).toBe(false);
    expect(deviceRegistrationSchema.safeParse({ ...valido, token: "a".repeat(1025) }).success).toBe(
      false,
    );
  });
});

describe("deviceDeletionSchema", () => {
  it("vuole un token non vuoto", () => {
    expect(deviceDeletionSchema.safeParse({ token: "tok-1" }).success).toBe(true);
    expect(deviceDeletionSchema.safeParse({}).success).toBe(false);
    expect(deviceDeletionSchema.safeParse({ token: "" }).success).toBe(false);
  });

  it("ha lo STESSO tetto della registrazione", () => {
    // Se i due tetti divergessero esisterebbe un token registrabile e non
    // cancellabile: un device impossibile da spegnere dal logout.
    const oltre = "a".repeat(1025);
    expect(deviceDeletionSchema.safeParse({ token: oltre }).success).toBe(false);
    expect(
      deviceRegistrationSchema.safeParse({ platform: "ios", token: oltre }).success,
    ).toBe(false);
  });
});
