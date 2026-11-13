import type { GmailMessage } from "@stubwise/google";
import { describe, expect, it } from "vitest";
import { recognizeGeminiNotes } from "./gemini.js";

/**
 * L'email degli appunti di Gemini (area 6, F5a, C1): riconosciuta SOLO con
 * mittente, l'esito di Gmail (DMARC o DKIM di google.com nella PRIMA
 * `Authentication-Results`, quella di `mx.google.com`) e il link al Doc.
 * Fail-closed: in dubbio è un'email normale.
 */

const AUTH_OK = "mx.google.com; dkim=pass header.i=@google.com header.s=20230601 header.b=abc; spf=pass smtp.mailfrom=gemini-notes@google.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=google.com";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function message(over: { from?: string; auth?: string[]; body?: string } = {}): GmailMessage {
  const headers = [
    ...(over.auth ?? [AUTH_OK]).map((value) => ({ name: "Authentication-Results", value })),
    { name: "From", value: `Gemini <${over.from ?? "gemini-notes@google.com"}>` },
    { name: "Subject", value: "Notes: “Revisione settimanale”" },
  ];
  return {
    id: "m1",
    threadId: "t1",
    labelIds: [],
    snippet: "",
    historyId: null,
    internalDate: new Date(),
    headers: { from: `Gemini <${over.from ?? "gemini-notes@google.com"}>`, subject: "Notes: “Revisione settimanale”" },
    payload: {
      mimeType: "text/html",
      headers,
      body: { data: b64(over.body ?? '<p>Your notes are ready</p><a href="https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit?usp=meet_tnfm_email">Open</a>') },
    },
  };
}

describe("recognizeGeminiNotes", () => {
  it("mittente, DKIM/DMARC di google.com e il link al Doc: riconosciuta, col fileId e il titolo dall'oggetto", () => {
    expect(recognizeGeminiNotes(message())).toEqual({ docCandidates: ["1AbCdEfGhIjKlMnOpQrStUvWxYz012345"], meetingTitle: "Revisione settimanale" });
  });

  it("un altro mittente non lo è", () => {
    expect(recognizeGeminiNotes(message({ from: "gemini-notes@g00gle.com" }))).toBeNull();
  });

  it("senza esito di Gmail, con DKIM fallito, o con un esito falso SOTTO quello vero di Gmail: non lo è", () => {
    expect(recognizeGeminiNotes(message({ auth: [] }))).toBeNull();
    expect(recognizeGeminiNotes(message({ auth: ["mx.google.com; dkim=fail header.i=@google.com; dmarc=fail header.from=google.com"] }))).toBeNull();
    // Il mittente falso aggiunge la SUA intestazione: Gmail mette la propria in cima.
    expect(recognizeGeminiNotes(message({ auth: ["mx.google.com; dkim=none; spf=softfail; dmarc=fail header.from=google.com", AUTH_OK] }))).toBeNull();
    // Un server che non è Gmail non vale.
    expect(recognizeGeminiNotes(message({ auth: [AUTH_OK.replace("mx.google.com", "mx.altro.it")] }))).toBeNull();
  });

  it("senza il link a un Google Doc non lo è (un PDF, un altro sito, nessun link)", () => {
    expect(recognizeGeminiNotes(message({ body: '<a href="https://evil.example/document/d/1AbCdEfGhIjKlMnOpQrSt">x</a>' }))).toBeNull();
    expect(recognizeGeminiNotes(message({ body: "<p>nessun link</p>" }))).toBeNull();
  });
});

describe("review F5a, punti 2 e 7", () => {
  it("un link nel TITOLO della riunione è solo un candidato: ci sono tutti, in ordine (la verifica su Drive decide)", () => {
    const body = '<p>Notes: Revisione https://docs.google.com/document/d/ATTACKER0000000000000000/edit</p><a href="https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit">Open</a>';
    expect(recognizeGeminiNotes(message({ body }))?.docCandidates).toEqual(["ATTACKER0000000000000000", "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"]);
  });

  it("`header.from=google.com.evil.tld` non è google.com, e serve DMARC: un DKIM da solo non basta", () => {
    expect(recognizeGeminiNotes(message({ auth: [AUTH_OK.replace("header.from=google.com", "header.from=google.com.evil.tld")] }))).toBeNull();
    expect(recognizeGeminiNotes(message({ auth: ["mx.google.com; dkim=pass header.i=@google.com; dmarc=fail header.from=google.com"] }))).toBeNull();
  });
});
