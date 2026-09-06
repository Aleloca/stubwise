import { describe, expect, it } from "vitest";
import {
  deviceDeletionSchema,
  deviceRegistrationSchema,
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
