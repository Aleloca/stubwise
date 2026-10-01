import { describe, expect, it } from "vitest";
import { hasStubwiseReviewSignature, signReviewBody, stubwiseReviewSignature } from "./review-signature.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("firma delle review di Stubwise", () => {
  it("la firma GENERATA dalla funzione vera si riconosce", () => {
    expect(hasStubwiseReviewSignature(signReviewBody("## Verdetto\n\nModifiche richieste.", SHA))).toBe(true);
    expect(hasStubwiseReviewSignature(stubwiseReviewSignature(SHA))).toBe(true);
    expect(stubwiseReviewSignature(SHA)).toBe("_— Stubwise PR Review · `0123456`_");
  });

  it("spazi e righe vuote DOPO la firma sono ammessi (anche CRLF)", () => {
    expect(hasStubwiseReviewSignature(`${signReviewBody("x", SHA)}\n\n  \n`)).toBe(true);
    expect(hasStubwiseReviewSignature(`x\r\n\r\n${stubwiseReviewSignature(SHA)}\r\n`)).toBe(true);
  });

  it("un commento umano che NOMINA Stubwise non è una firma", () => {
    expect(hasStubwiseReviewSignature("Stubwise PR Review dice di cambiare il nome, sono d'accordo")).toBe(false);
    expect(hasStubwiseReviewSignature("Vedi la Stubwise PR Review sopra")).toBe(false);
  });

  it("la firma in MEZZO al testo, non in fondo, non conta", () => {
    expect(hasStubwiseReviewSignature(`${signReviewBody("citata:", SHA)}\n\nNon sono d'accordo con questa review.`)).toBe(
      false,
    );
  });

  it("sha di lunghezza diversa da 7, o non esadecimale: non è la firma", () => {
    expect(hasStubwiseReviewSignature("x\n\n_— Stubwise PR Review · `012345`_")).toBe(false);
    expect(hasStubwiseReviewSignature("x\n\n_— Stubwise PR Review · `01234567`_")).toBe(false);
    expect(hasStubwiseReviewSignature("x\n\n_— Stubwise PR Review · `012345g`_")).toBe(false);
  });

  it("la firma deve stare su una riga sua", () => {
    expect(hasStubwiseReviewSignature(`testo ${stubwiseReviewSignature(SHA)}`)).toBe(false);
  });

  it("null o assente: nessuna firma", () => {
    expect(hasStubwiseReviewSignature(null)).toBe(false);
    expect(hasStubwiseReviewSignature(undefined)).toBe(false);
  });
});
