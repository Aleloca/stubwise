import type { GmailMessage } from "@stubwise/google";
import { DEFAULT_METADATA_HEADERS } from "@stubwise/google";
import { describe, expect, it } from "vitest";
import { buildEmailMessageInsert } from "./sync.js";

/**
 * Dalla risposta di Gmail alla riga di `email_messages`.
 *
 * Il caso che questo file presidia più degli altri è l'ULTIMO: un messaggio
 * SENZA header `Cc` deve dare `[]`, non `null`. È la riga che distingue
 * «guardato, nessuno in copia» da «mai guardato», e se si rompe lo script di
 * recupero (`backfill-email-cc.ts`) ricomincia a chiamare Google su righe già
 * viste, a ogni lancio, per sempre.
 */

function message(headers: Record<string, string> = {}): GmailMessage {
  return {
    id: "m-1",
    threadId: "t-1",
    labelIds: ["INBOX"],
    snippet: "",
    historyId: "100",
    internalDate: new Date("2026-09-15T09:00:00.000Z"),
    headers: {
      from: "Lavinia Corsi <lavinia.corsi@hays.com>",
      to: "a.locatelli@thecove.it",
      subject: "Hays | PHP Developer",
      ...headers,
    },
  };
}

function build(msg: GmailMessage) {
  return buildEmailMessageInsert({
    accountId: "acc-1",
    message: msg,
    text: "corpo",
    projectId: null,
    candidateProjectIds: [],
    scopeProjectIds: [],
    now: new Date("2026-09-16T00:00:00.000Z"),
  });
}

describe("buildEmailMessageInsert — chi è in copia", () => {
  it("l'header `Cc` finisce in colonna, con più indirizzi", () => {
    const row = build(message({ cc: "m.misseri@thecove.it, g.rossi@acme.test" }));
    expect(row.ccAddresses).toEqual(["m.misseri@thecove.it", "g.rossi@acme.test"]);
  });

  it("normalizza come `to`: nomi visualizzati tolti, minuscolo", () => {
    const row = build(message({ cc: "Marco Misseri <M.Misseri@THECOVE.it>" }));
    expect(row.ccAddresses).toEqual(["m.misseri@thecove.it"]);
  });

  it("⚠️ senza header `Cc` dà `[]`, MAI `null`", () => {
    // `[]` = «guardato, nessuno in copia»; `null` in colonna = «riga scritta
    // prima della colonna, non lo sappiamo». Scrivere `null` da qui farebbe
    // ripartire lo script di recupero su righe già viste, per sempre.
    const row = build(message());
    expect(row.ccAddresses).toEqual([]);
    expect(row.ccAddresses).not.toBeNull();
  });

  it("un `Cc` vuoto o di soli spazi è comunque «guardato, nessuno»", () => {
    expect(build(message({ cc: "" })).ccAddresses).toEqual([]);
    expect(build(message({ cc: "   " })).ccAddresses).toEqual([]);
  });

  it("⚠️ NESSUNA chiamata nuova a Gmail: `Cc` è già fra gli header chiesti", () => {
    // È la premessa del task. Se qualcuno togliesse `Cc` da questa lista, il
    // campo arriverebbe sempre vuoto e nessun altro test se ne accorgerebbe —
    // le fixture qui sopra l'header ce l'hanno perché glielo mettiamo noi.
    expect(DEFAULT_METADATA_HEADERS).toContain("Cc");
  });

  it("il resto della riga non cambia", () => {
    const row = build(message({ cc: "m.misseri@thecove.it" }));
    expect(row.toAddresses).toEqual(["a.locatelli@thecove.it"]);
    expect(row.fromAddress).toBe("lavinia.corsi@hays.com");
    expect(row.subject).toBe("Hays | PHP Developer");
    expect(row.admitted).toBe(true);
  });
});
