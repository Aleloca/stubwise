// Prova fastifyErrorHandler dell'SDK contro un Fastify v5 REALE (non il
// RequestLike sintetico dei test dell'SDK). La registrazione tramite
// app.setErrorHandler è essa stessa metà dell'asserzione: se la firma
// dell'handler non fosse assegnabile ai tipi di Fastify v5, il typecheck
// fallirebbe. L'altra metà: il client riceve comunque una 500 (l'handler
// rilancia e Fastify ripiega sul proprio default) e l'evento d'errore
// arriva al transport (fetch mockata, ispezionata dopo flush).
import { __resetForTesting, fastifyErrorHandler, flush, init } from "@stubwise/sdk/node";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const DSN = "https://test-key@track.example.com/p/my-app";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function okFetch(): FetchMock {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
}

/** Tutti gli eventi consegnati al transport, su tutte le chiamate fetch. */
function deliveredEvents(fetchMock: FetchMock): Record<string, unknown>[] {
  return fetchMock.mock.calls.flatMap(
    (call) =>
      (JSON.parse(call[1]?.body as string) as { events: Record<string, unknown>[] }).events,
  );
}

afterEach(() => {
  __resetForTesting();
  vi.restoreAllMocks();
});

describe("fastifyErrorHandler registrato su un Fastify v5 reale", () => {
  it("cattura l'errore della route, ma il client riceve comunque la 500 di default", async () => {
    const fetchMock = okFetch();
    init({ dsn: DSN, fetchImpl: fetchMock, registerProcessHandlers: false });

    const app = Fastify();
    app.setErrorHandler(fastifyErrorHandler());
    app.get("/boom", () => {
      throw new Error("esplosione nella route reale");
    });

    try {
      const response = await app.inject({ method: "GET", url: "/boom" });

      // l'handler rilancia: Fastify ripiega sul default handler → 500 al client
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        statusCode: 500,
        error: "Internal Server Error",
        message: "esplosione nella route reale",
      });

      await flush();
      expect(deliveredEvents(fetchMock)).toEqual([
        expect.objectContaining({
          kind: "error",
          message: "esplosione nella route reale",
          url: "/boom",
        }),
      ]);
    } finally {
      await app.close();
    }
  });
});
