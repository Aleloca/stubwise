import { describe, expect, it } from "vitest";
import { GoogleApiError, isFatalGoogleError } from "./errors.js";
import {
  extractText,
  getMessageFull,
  getMessageMetadata,
  listHistory,
  listMessages,
  MAX_TEXT_LENGTH,
  TEXT_TRUNCATION_MARKER,
  type GmailPayload,
} from "./gmail.js";
import { b64url, fakeFetch, jsonResponse } from "./test-support.js";

describe("listHistory", () => {
  it("chiede la history da startHistoryId e raccoglie gli id dei messaggi aggiunti senza duplicati", async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({
        history: [
          { id: "101", messagesAdded: [{ message: { id: "m1", threadId: "t1" } }, { message: { id: "m2", threadId: "t2" } }] },
          { id: "102", messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] },
          { id: "103", labelsAdded: [{ message: { id: "m9" } }] },
        ],
        historyId: "104",
        nextPageToken: "p2",
      }),
    ]);
    const page = await listHistory({ accessToken: "at", startHistoryId: "100", pageToken: "p1" }, { fetchImpl: impl });
    const call = calls[0];
    expect(call?.url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/history")).toBe(true);
    expect(call?.headers.authorization).toBe("Bearer at");
    expect(call?.params.get("startHistoryId")).toBe("100");
    expect(call?.params.get("pageToken")).toBe("p1");
    expect(call?.params.getAll("historyTypes")).toEqual(["messageAdded"]);
    expect(page).toEqual({ addedMessageIds: ["m1", "m2"], historyId: "104", nextPageToken: "p2" });
  });

  it("404 significa history scaduta: code history_expired, NON fatale (si fa un resync)", async () => {
    const { impl } = fakeFetch([
      jsonResponse({ error: { code: 404, message: "Requested entity was not found.", errors: [{ reason: "notFound" }] } }, { status: 404 }),
    ]);
    const error = await listHistory({ accessToken: "at", startHistoryId: "1" }, { fetchImpl: impl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    const api = error as GoogleApiError;
    expect(api.status).toBe(404);
    expect(api.code).toBe("history_expired");
    expect(api.reason).toBe("notFound");
    expect(isFatalGoogleError(api)).toBe(false);
  });
});

describe("listMessages", () => {
  it("passa la query e il tetto di risultati, e restituisce i soli id", async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({ messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }], nextPageToken: "n" }),
    ]);
    const page = await listMessages({ accessToken: "at", q: "newer_than:7d -from:me", maxResults: 200 }, { fetchImpl: impl });
    expect(calls[0]?.params.get("q")).toBe("newer_than:7d -from:me");
    expect(calls[0]?.params.get("maxResults")).toBe("200");
    expect(page).toEqual({ messageIds: ["m1", "m2"], nextPageToken: "n" });
  });

  it("una casella senza risultati dà una lista vuota, non un errore", async () => {
    const { impl } = fakeFetch([jsonResponse({ resultSizeEstimate: 0 })]);
    await expect(listMessages({ accessToken: "at" }, { fetchImpl: impl })).resolves.toEqual({
      messageIds: [],
      nextPageToken: null,
    });
  });
});

describe("getMessageMetadata", () => {
  it("chiede format=metadata con gli header che servono al routing e li normalizza in minuscolo", async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX", "Label_7"],
        historyId: "555",
        internalDate: "1757246400000",
        snippet: "ciao",
        payload: {
          headers: [
            { name: "From", value: "Ada <ada@acme.test>" },
            { name: "To", value: "team@stubwise.test" },
            { name: "Subject", value: "Contratto" },
          ],
        },
      }),
    ]);
    const message = await getMessageMetadata({ accessToken: "at", id: "m1" }, { fetchImpl: impl });
    expect(calls[0]?.url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/m1")).toBe(true);
    expect(calls[0]?.params.get("format")).toBe("metadata");
    expect(calls[0]?.params.getAll("metadataHeaders")).toContain("From");
    expect(calls[0]?.params.getAll("metadataHeaders")).toContain("Cc");
    expect(message.id).toBe("m1");
    expect(message.threadId).toBe("t1");
    expect(message.labelIds).toEqual(["INBOX", "Label_7"]);
    expect(message.headers.from).toBe("Ada <ada@acme.test>");
    expect(message.headers.subject).toBe("Contratto");
    expect(message.internalDate?.toISOString()).toBe(new Date(1757246400000).toISOString());
  });
});

describe("getMessageFull", () => {
  it("chiede format=full e restituisce il payload MIME grezzo", async () => {
    const { impl, calls } = fakeFetch([
      jsonResponse({
        id: "m1",
        threadId: "t1",
        labelIds: [],
        internalDate: "0",
        payload: { mimeType: "text/plain", body: { data: b64url("ciao") } },
      }),
    ]);
    const message = await getMessageFull({ accessToken: "at", id: "m1" }, { fetchImpl: impl });
    expect(calls[0]?.params.get("format")).toBe("full");
    expect(message.payload?.mimeType).toBe("text/plain");
    expect(extractText(message.payload!)).toBe("ciao");
  });
});

describe("extractText", () => {
  it("preferisce text/plain quando il multipart ha sia plain sia html", () => {
    const payload: GmailPayload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("Versione testo") } },
        { mimeType: "text/html", body: { data: b64url("<p>Versione <b>HTML</b></p>") } },
      ],
    };
    expect(extractText(payload)).toBe("Versione testo");
  });

  it("scende nel multipart/mixed e ignora gli allegati", () => {
    const payload: GmailPayload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("Corpo utile") } },
            { mimeType: "text/html", body: { data: b64url("<p>Corpo utile</p>") } },
          ],
        },
        { mimeType: "application/pdf", filename: "contratto.pdf", body: { attachmentId: "a1", size: 1000 } },
        { mimeType: "text/plain", filename: "note.txt", body: { data: b64url("ALLEGATO DA IGNORARE") } },
      ],
    };
    const text = extractText(payload);
    expect(text).toBe("Corpo utile");
    expect(text).not.toContain("ALLEGATO");
  });

  it("converte l'HTML in testo quando manca il text/plain: via <style>, via <blockquote>, entità decodificate", () => {
    const html = [
      "<html><head><style>.x { color: red }</style></head><body>",
      "<p>Ciao Ada &amp; Bob,</p>",
      "<p>confermiamo per il 12 marzo &mdash; ore 10&nbsp;&lt;CET&gt;.</p>",
      "<blockquote>Il 5 marzo Bob ha scritto: possiamo spostare?</blockquote>",
      "<script>alert('no')</script>",
      "</body></html>",
    ].join("");
    const text = extractText({ mimeType: "text/html", body: { data: b64url(html) } });
    expect(text).toContain("Ciao Ada & Bob,");
    expect(text).toContain("confermiamo per il 12 marzo — ore 10 <CET>.");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("possiamo spostare?");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("&amp;");
  });

  it("taglia la citazione inglese «On … wrote:» e tutto ciò che segue", () => {
    const body = [
      "Va bene per me.",
      "",
      "On Mon, Sep 7, 2026 at 10:00 AM Bob <bob@acme.test> wrote:",
      "> Possiamo confermare?",
      "> Grazie",
    ].join("\n");
    expect(extractText({ mimeType: "text/plain", body: { data: b64url(body) } })).toBe("Va bene per me.");
  });

  it("taglia la citazione italiana «Il … ha scritto:» anche quando è spezzata su due righe", () => {
    const body = [
      "Confermo la data.",
      "",
      "Il giorno lun 7 set 2026 alle ore 10:00 Bob <bob@acme.test> ha",
      "scritto:",
      "> Possiamo confermare?",
    ].join("\n");
    expect(extractText({ mimeType: "text/plain", body: { data: b64url(body) } })).toBe("Confermo la data.");
  });

  it("taglia la firma dopo il separatore «-- »", () => {
    const body = ["Ci vediamo lunedì.", "", "-- ", "Ada Lovelace", "CTO, Acme", "+39 000 000"].join("\n");
    expect(extractText({ mimeType: "text/plain", body: { data: b64url(body) } })).toBe("Ci vediamo lunedì.");
  });

  it("toglie le righe citate con «>» rimaste in mezzo al testo", () => {
    const body = ["Rispondo sotto.", "> domanda uno", "Sì.", ">> domanda due", "No."].join("\n");
    expect(extractText({ mimeType: "text/plain", body: { data: b64url(body) } })).toBe("Rispondo sotto.\nSì.\nNo.");
  });

  it("tronca oltre il cap e lo dichiara con un marcatore", () => {
    const long = "a".repeat(500);
    const text = extractText({ mimeType: "text/plain", body: { data: b64url(long) } }, { maxLength: 100 });
    expect(text.length).toBe(100);
    expect(text.endsWith(TEXT_TRUNCATION_MARKER)).toBe(true);
    expect(text.startsWith("aaaa")).toBe(true);
  });

  it("il cap di default è quello di text_excerpt (20k)", () => {
    expect(MAX_TEXT_LENGTH).toBe(20_000);
    const text = extractText({ mimeType: "text/plain", body: { data: b64url("b".repeat(MAX_TEXT_LENGTH + 10)) } });
    expect(text.length).toBe(MAX_TEXT_LENGTH);
    expect(text.endsWith(TEXT_TRUNCATION_MARKER)).toBe(true);
  });

  it("un payload senza parti testuali dà stringa vuota", () => {
    expect(extractText({ mimeType: "multipart/mixed", parts: [{ mimeType: "image/png", body: { attachmentId: "a" } }] })).toBe(
      "",
    );
    expect(extractText({})).toBe("");
  });
});
