import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "./verify.js";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const RAW_BODY = "token=xyz&team_id=T123&command=%2Fstubwise&text=ciao";
// Timestamp fisso e `now` corrispondente: la firma resta dentro la finestra.
const TIMESTAMP = "1700000000";
const NOW = 1_700_000_000_000;

/** Calcola la firma valida per un dato body/timestamp/secret. */
function sign(rawBody: string, timestamp: string, secret: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  it("firma valida → true", () => {
    expect(
      verifySlackSignature({
        rawBody: RAW_BODY,
        signature: sign(RAW_BODY, TIMESTAMP, SIGNING_SECRET),
        timestamp: TIMESTAMP,
        signingSecret: SIGNING_SECRET,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("firma manomessa → false", () => {
    const tampered = `${sign(RAW_BODY, TIMESTAMP, SIGNING_SECRET).slice(0, -1)}0`;
    expect(
      verifySlackSignature({
        rawBody: RAW_BODY,
        signature: tampered,
        timestamp: TIMESTAMP,
        signingSecret: SIGNING_SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("body diverso da quello firmato → false", () => {
    expect(
      verifySlackSignature({
        rawBody: `${RAW_BODY}&extra=1`,
        signature: sign(RAW_BODY, TIMESTAMP, SIGNING_SECRET),
        timestamp: TIMESTAMP,
        signingSecret: SIGNING_SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("timestamp scaduto (>300s) → false anche con firma corretta", () => {
    const sig = sign(RAW_BODY, TIMESTAMP, SIGNING_SECRET);
    // now spostato di 301 secondi oltre il timestamp.
    expect(
      verifySlackSignature({
        rawBody: RAW_BODY,
        signature: sig,
        timestamp: TIMESTAMP,
        signingSecret: SIGNING_SECRET,
        now: NOW + 301_000,
      }),
    ).toBe(false);
  });

  it("timestamp troppo nel futuro (>300s) → false", () => {
    const sig = sign(RAW_BODY, TIMESTAMP, SIGNING_SECRET);
    expect(
      verifySlackSignature({
        rawBody: RAW_BODY,
        signature: sig,
        timestamp: TIMESTAMP,
        signingSecret: SIGNING_SECRET,
        now: NOW - 301_000,
      }),
    ).toBe(false);
  });

  it("header firma assente → false", () => {
    expect(
      verifySlackSignature({
        rawBody: RAW_BODY,
        signature: undefined,
        timestamp: TIMESTAMP,
        signingSecret: SIGNING_SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("header timestamp assente → false", () => {
    expect(
      verifySlackSignature({
        rawBody: RAW_BODY,
        signature: sign(RAW_BODY, TIMESTAMP, SIGNING_SECRET),
        timestamp: undefined,
        signingSecret: SIGNING_SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("timestamp non numerico → false", () => {
    expect(
      verifySlackSignature({
        rawBody: RAW_BODY,
        signature: sign(RAW_BODY, "abc", SIGNING_SECRET),
        timestamp: "abc",
        signingSecret: SIGNING_SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });
});
