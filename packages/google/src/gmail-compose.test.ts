import { describe, expect, it } from "vitest";
import { buildMimeMessage, createDraft, deleteDraft, encodeRaw, getDraft, getSendAsSignature, sendDraft, updateDraft } from "./gmail-compose.js";
import { fakeFetch, jsonResponse } from "./test-support.js";

/**
 * Scrivere su Gmail (area 6, F3): il MIME (testo semplice, intestazioni
 * codificate, la risposta nel thread, gli allegati) e le bozze di Gmail.
 */

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

describe("buildMimeMessage", () => {
  it("testo semplice UTF-8, intestazioni e oggetto non ASCII codificati (RFC 2047)", () => {
    const mime = buildMimeMessage({
      from: { email: "ada@acme.com", name: "Ada Lovelace" },
      to: [{ email: "c@cliente.it", name: "Città Cliente" }],
      cc: [],
      subject: "Re: Perché è urgente",
      body: "Ciao,\nfatto è già.",
    });
    expect(mime).toContain("MIME-Version: 1.0");
    expect(mime).toContain('From: "Ada Lovelace" <ada@acme.com>');
    expect(mime).toContain("To: =?UTF-8?B?");
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Re: Perché è urgente").toString("base64")}?=`);
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    const body = mime.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Ciao,\nfatto è già.");
    expect(mime).not.toContain("Cc:");
  });

  it("la risposta porta In-Reply-To e References", () => {
    const mime = buildMimeMessage({
      from: { email: "a@acme.com" },
      to: [{ email: "b@x.it" }],
      cc: [{ email: "c@x.it" }],
      subject: "Re: x",
      body: "ok",
      inReplyTo: "<m1@x.it>",
      references: ["<m0@x.it>", "<m1@x.it>"],
    });
    expect(mime).toContain("In-Reply-To: <m1@x.it>");
    expect(mime).toContain("References: <m0@x.it> <m1@x.it>");
    expect(mime).toContain("Cc: c@x.it");
  });

  it("gli allegati in multipart/mixed, ognuno col suo nome e in base64", () => {
    const mime = buildMimeMessage({
      from: { email: "a@acme.com" },
      to: [{ email: "b@x.it" }],
      cc: [],
      subject: "file",
      body: "in allegato",
      attachments: [{ name: "relazione è.pdf", mimeType: "application/pdf", content: Buffer.from("PDFDATA") }],
    });
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="([^"]+)"/);
    expect(mime).toContain('Content-Type: application/pdf; name="=?UTF-8?B?');
    expect(mime).toContain("Content-Disposition: attachment; filename=");
    expect(mime).toContain(Buffer.from("PDFDATA").toString("base64"));
  });

  it("un CR/LF in un'intestazione non apre un'intestazione nuova (nessuna iniezione)", () => {
    const mime = buildMimeMessage({ from: { email: "a@acme.com" }, to: [{ email: "b@x.it" }], cc: [], subject: "x\r\nBcc: spia@evil.com", body: "" });
    expect(mime).not.toMatch(/^Bcc:/m);
    // Anche dove il valore NON si codifica: un indirizzo e In-Reply-To.
    const viaAddress = buildMimeMessage({ from: { email: "a@acme.com" }, to: [{ email: "b@x.it\r\nBcc: spia@evil.com" }], cc: [], subject: "x", body: "", inReplyTo: "<m@x>\r\nBcc: altra@evil.com" });
    expect(viaAddress).not.toMatch(/^Bcc:/m);
  });

  it("encodeRaw: base64url senza padding, come vuole Gmail", () => {
    const raw = encodeRaw("a?b>c");
    expect(raw).not.toMatch(/[+/=]/);
    expect(decode(raw)).toBe("a?b>c");
  });
});

describe("le bozze di Gmail", () => {
  it("crea: POST drafts col raw e il thread, e restituisce id e messaggio", async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ id: "d1", message: { id: "m1", threadId: "t1" } })]);
    const out = await createDraft({ accessToken: "at", raw: "UkFX", threadId: "t1" }, { fetchImpl: impl });
    expect(out).toEqual({ id: "d1", messageId: "m1", threadId: "t1" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ message: { raw: "UkFX", threadId: "t1" } });
  });

  it("aggiorna: PUT sulla bozza; legge: GET format=minimal; elimina: DELETE senza corpo", async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({ id: "d1", message: { id: "m2", threadId: "t1" } }),
      jsonResponse({ id: "d1", message: { id: "m2", threadId: "t1" } }),
      new Response(null, { status: 204 }),
    ]);
    expect(await updateDraft({ accessToken: "at", id: "d1", raw: "UkFX" }, { fetchImpl: impl })).toEqual({ id: "d1", messageId: "m2", threadId: "t1" });
    expect(await getDraft({ accessToken: "at", id: "d1" }, { fetchImpl: impl })).toEqual({ id: "d1", messageId: "m2", threadId: "t1" });
    await deleteDraft({ accessToken: "at", id: "d1" }, { fetchImpl: impl });
    expect(calls.map((c) => c.method)).toEqual(["PUT", "GET", "DELETE"]);
    expect(calls[1]!.params.get("format")).toBe("minimal");
    expect(calls[2]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1");
  });

  it("invia: POST drafts/send con l'id, e restituisce il messaggio mandato", async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ id: "m9", threadId: "t9", labelIds: ["SENT"] })]);
    expect(await sendDraft({ accessToken: "at", id: "d1" }, { fetchImpl: impl })).toEqual({ messageId: "m9", threadId: "t9" });
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ id: "d1" });
  });

  it("una bozza che non c'è più: GoogleApiError 404", async () => {
    const { impl } = fakeFetch([jsonResponse({ error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } }, { status: 404 })]);
    await expect(getDraft({ accessToken: "at", id: "x" }, { fetchImpl: impl })).rejects.toMatchObject({ status: 404 });
  });
});

describe("getSendAsSignature (la firma di Gmail, F3: basta gmail.modify)", () => {
  it("GET sendAs/<indirizzo>: la firma in testo, null se vuota; l'indirizzo è codificato nel path", async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({ sendAsEmail: "ada@acme.com", signature: "<div>Ada Lovelace<br>Acme &amp; co.</div>" }),
      jsonResponse({ sendAsEmail: "ada@acme.com", signature: "" }),
    ]);
    expect(await getSendAsSignature({ accessToken: "at", sendAsEmail: "ada+x@acme.com" }, { fetchImpl: impl })).toBe("Ada Lovelace\nAcme & co.");
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs/ada%2Bx%40acme.com");
    expect(await getSendAsSignature({ accessToken: "at", sendAsEmail: "ada@acme.com" }, { fetchImpl: impl })).toBeNull();
  });
});
