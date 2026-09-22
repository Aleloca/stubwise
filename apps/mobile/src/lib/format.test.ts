import { clockTime, elapsedMinutes, openedSince, relativeTimeCompact, searchMailTime, shortDate } from "./format";

const NOW = new Date("2026-09-02T10:00:00.000Z").getTime();

test("meno di un minuto: 'now'", () => {
  const iso = new Date("2026-09-02T09:59:45.000Z").toISOString();
  expect(relativeTimeCompact(iso, NOW)).toEqual({ kind: "now" });
});

test("12 minuti: 'minutes' con count=12", () => {
  const iso = new Date("2026-09-02T09:48:00.000Z").toISOString();
  expect(relativeTimeCompact(iso, NOW)).toEqual({ kind: "minutes", count: 12 });
});

test("1 ora e mezza: 'hours' con count=1 (troncato, non arrotondato)", () => {
  const iso = new Date("2026-09-02T08:29:00.000Z").toISOString();
  expect(relativeTimeCompact(iso, NOW)).toEqual({ kind: "hours", count: 1 });
});

test("25 ore: 'days' con count=1", () => {
  const iso = new Date("2026-09-01T09:00:00.000Z").toISOString();
  expect(relativeTimeCompact(iso, NOW)).toEqual({ kind: "days", count: 1 });
});

// Mutazione da rompere apposta: se il calcolo usasse i millisecondi grezzi
// invece di dividerli per 60_000, "12 minuti" diventerebbe un numero enorme.
test("il conteggio è in minuti, non in millisecondi grezzi", () => {
  const iso = new Date("2026-09-02T09:58:00.000Z").toISOString();
  const result = relativeTimeCompact(iso, NOW);
  expect(result).toEqual({ kind: "minutes", count: 2 });
});

test("un timestamp futuro (clock skew) non va mai sotto zero", () => {
  const iso = new Date("2026-09-02T10:05:00.000Z").toISOString();
  expect(relativeTimeCompact(iso, NOW)).toEqual({ kind: "now" });
});

describe("elapsedMinutes", () => {
  test("18 minuti: conteggio continuo, non bucket", () => {
    const iso = new Date("2026-09-02T09:42:00.000Z").toISOString();
    expect(elapsedMinutes(iso, NOW)).toBe(18);
  });

  test("oltre un'ora (78 min): NON collassa a 'ore', a differenza di relativeTimeCompact", () => {
    const iso = new Date("2026-09-02T08:42:00.000Z").toISOString();
    expect(elapsedMinutes(iso, NOW)).toBe(78);
  });

  test("un timestamp futuro (clock skew) non va mai sotto zero", () => {
    const iso = new Date("2026-09-02T10:05:00.000Z").toISOString();
    expect(elapsedMinutes(iso, NOW)).toBe(0);
  });
});

describe("clockTime", () => {
  test("l'ora è quella LOCALE di chi guarda, non UTC", () => {
    // Il fuso del runner non è fissato: si verifica la relazione, non una
    // stringa — è comunque ciò che conta (i getter locali, non gli UTC).
    const iso = "2026-09-14T09:30:00.000Z";
    const at = new Date(iso);
    expect(clockTime(iso)).toBe(
      `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`,
    );
  });

  test("padding a due cifre su ore e minuti", () => {
    const at = new Date(2026, 8, 14, 7, 5);
    expect(clockTime(at.toISOString())).toBe("07:05");
  });
});

describe("shortDate", () => {
  it("giorno, mese e anno a due cifre, con lo zero davanti", () => {
    expect(shortDate("2026-06-05T10:00:00.000Z")).toBe("05/06/26");
    expect(shortDate("2026-12-31T10:00:00.000Z")).toBe("31/12/26");
  });

  it("il mese è quello umano, non l'indice da zero di JavaScript", () => {
    // `getMonth()` torna 0 per gennaio: senza il +1 questa riga direbbe 00.
    expect(shortDate("2026-01-15T10:00:00.000Z")).toBe("15/01/26");
  });

  it("anni sotto il 2010: lo zero non si perde", () => {
    expect(shortDate("2009-03-07T10:00:00.000Z")).toBe("07/03/09");
  });
});

/**
 * `searchMailTime` (16 set 2026): l'orario per oggi, giorno+orario oltre.
 *
 * ⚠️ NON è `relativeTimeCompact`: la lista MBX usa quella («3 g»), questa la
 * riga di ricerca. Il design diceva che fossero la stessa regola — non lo
 * sono, e il docblock della funzione spiega perché non si è uniformata la
 * lista MBX. Questi test fissano la differenza, così non si «semplifica».
 */
describe("searchMailTime", () => {
  const NOW = new Date("2026-09-16T12:00:00").getTime();

  it("stesso giorno: solo l'orario", () => {
    expect(searchMailTime(new Date("2026-09-16T17:45:00").toISOString(), NOW)).toBe("17:45");
    // Anche a mezzanotte e un minuto: è comunque oggi.
    expect(searchMailTime(new Date("2026-09-16T00:01:00").toISOString(), NOW)).toBe("00:01");
  });

  it("giorno diverso: giorno, mese e orario", () => {
    expect(searchMailTime(new Date("2026-09-10T17:45:00").toISOString(), NOW)).toBe("10/09 17:45");
  });

  it("ieri sera è IERI, anche se sono passate poche ore", () => {
    // La soglia è il GIORNO di calendario, non «24 ore fa»: alle 12 di oggi,
    // un messaggio delle 23 di ieri è di ieri, e dirlo «13 h» sarebbe
    // un'altra domanda.
    expect(searchMailTime(new Date("2026-09-15T23:00:00").toISOString(), NOW)).toBe("15/09 23:00");
  });

  it("un anno diverso non si confonde con lo stesso giorno-mese", () => {
    expect(searchMailTime(new Date("2025-09-16T17:45:00").toISOString(), NOW)).toBe("16/09 17:45");
  });
});

describe("openedSince — l'età di un ticket, non la freschezza di una card", () => {
  const ORA = new Date("2026-09-22T12:00:00.000Z").getTime();
  const giorniFa = (n: number) => new Date(ORA - n * 24 * 60 * 60 * 1000).toISOString();

  it("meno di un giorno: «oggi», non «0 g»", () => {
    expect(openedSince(new Date(ORA - 3 * 60 * 60 * 1000).toISOString(), ORA)).toEqual({ kind: "today" });
  });

  it("dentro i due mesi conta i giorni", () => {
    expect(openedSince(giorniFa(8), ORA)).toEqual({ kind: "days", count: 8 });
    expect(openedSince(giorniFa(60), ORA)).toEqual({ kind: "days", count: 60 });
  });

  it("il confine giorni→mesi è a 60: 61 giorni sono «2 mesi»", () => {
    // Il bucket è ciò che distingue questa funzione da `relativeTimeCompact`,
    // che a 61 giorni direbbe «61 g» — ed è il motivo per cui è una funzione
    // NUOVA e non un ramo in più là dentro: quella la usa l'inbox.
    expect(openedSince(giorniFa(61), ORA)).toEqual({ kind: "months", count: 2 });
    expect(openedSince(giorniFa(95), ORA)).toEqual({ kind: "months", count: 3 });
  });

  it("`relativeTimeCompact` NON è cambiata: a 61 giorni dice ancora «61 g»", () => {
    // La prova che l'inbox non è stata toccata. Se un domani qualcuno
    // aggiungesse il bucket «mesi» là dentro «per coerenza», questo test lo
    // direbbe — ed è esattamente ciò per cui esiste.
    expect(relativeTimeCompact(giorniFa(61), ORA)).toEqual({ kind: "days", count: 61 });
  });

  it("una data nel FUTURO non produce un numero negativo", () => {
    // Orologi sfasati fra telefono e server: la guardia che tutte le funzioni
    // di questo modulo hanno.
    expect(openedSince(new Date(ORA + 5 * 24 * 60 * 60 * 1000).toISOString(), ORA)).toEqual({ kind: "today" });
  });

  it("una data illeggibile non produce NIENTE — nemmeno «oggi»", () => {
    // `null` e non `{kind:"today"}`: chi rende la riga omette il pezzo. Un
    // ripiego su «oggi» sarebbe un'affermazione FALSA su un ticket che
    // potrebbe essere di due mesi — la stessa ragione per cui `priority` è
    // `.optional()` e non `.default("medium")`.
    expect(openedSince("non-una-data", ORA)).toBeNull();
  });

  it("il futuro invece «oggi» lo dice per davvero: è un orologio sfasato, non un dato mancante", () => {
    // I due rami non sono la stessa cosa, e il test lo fissa: qui la data è
    // LEGGIBILE, quindi «aperto oggi» è vero.
    expect(openedSince(new Date(ORA + 5 * 60 * 1000).toISOString(), ORA)).toEqual({ kind: "today" });
  });
});

