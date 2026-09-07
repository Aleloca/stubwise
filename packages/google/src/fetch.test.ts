import { describe, expect, it } from "vitest";
import { GoogleApiError } from "./errors.js";
import { fetchWithTimeout, parseRetryAfterMs } from "./fetch.js";
import { fakeFetch } from "./test-support.js";

describe("parseRetryAfterMs", () => {
  it("legge i secondi", () => {
    expect(parseRetryAfterMs("7")).toBe(7000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("legge una data HTTP come distanza da adesso", () => {
    const now = Date.UTC(2026, 8, 7, 12, 0, 0);
    expect(parseRetryAfterMs(new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
  });

  it("non torna mai negativo per una data già passata", () => {
    const now = Date.UTC(2026, 8, 7, 12, 0, 0);
    expect(parseRetryAfterMs(new Date(now - 60_000).toUTCString(), now)).toBe(0);
  });

  it("ignora header assenti o illeggibili", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("presto")).toBeUndefined();
  });
});

describe("fetchWithTimeout", () => {
  it("usa il fetch iniettato e gli passa un AbortSignal", async () => {
    const { impl, calls } = fakeFetch([new Response("ok", { status: 200 })]);
    let sawSignal = false;
    const spy: typeof impl = async (input, init) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return impl(input, init);
    };
    const res = await fetchWithTimeout("https://example.test/x", { method: "GET" }, { fetchImpl: spy });
    expect(res.status).toBe(200);
    expect(sawSignal).toBe(true);
    expect(calls[0]?.url).toBe("https://example.test/x");
  });

  it("traduce un errore di rete in GoogleApiError transitorio", async () => {
    const boom: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await fetchWithTimeout("https://example.test/x", {}, { fetchImpl: boom }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    const api = error as GoogleApiError;
    expect(api.status).toBe(0);
    expect(api.code).toBe("network_error");
  });

  it("traduce lo scadere del timeout in GoogleApiError code timeout", async () => {
    const hangs: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject((init.signal as AbortSignal).reason);
        });
      });
    const error = await fetchWithTimeout("https://example.test/x", {}, { fetchImpl: hangs, timeoutMs: 5 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).code).toBe("timeout");
    expect((error as GoogleApiError).status).toBe(0);
  });
});
