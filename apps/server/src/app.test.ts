import { describe, it, expect } from "vitest";
import { buildApp, redactGoogleOauthCallbackUrl } from "./app.js";

describe("buildApp", () => {
  it("restituisce un'istanza Fastify", () => {
    const app = buildApp();
    expect(app).toBeDefined();
    expect(typeof app.inject).toBe("function");
    expect(typeof app.listen).toBe("function");
  });

  it("GET /health risponde 200 con {status:'ok'}", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("un errore non gestito risponde 500 senza esporre il messaggio interno", async () => {
    const app = buildApp();
    app.get("/boom", async () => {
      throw new Error("postgres secret detail");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("postgres secret detail");
    expect(res.json()).toEqual({ message: "Internal error" });
  });

  it("un errore con statusCode < 500 passa intatto", async () => {
    const app = buildApp();
    app.get("/teapot", async () => {
      const err = new Error("sono una teiera") as Error & { statusCode: number };
      err.statusCode = 418;
      throw err;
    });
    const res = await app.inject({ method: "GET", url: "/teapot" });
    expect(res.statusCode).toBe(418);
    expect(res.body).toContain("sono una teiera");
  });
});

/**
 * LOG DELLA RICHIESTA AL CALLBACK OAUTH GOOGLE (fase 6, Task 5a).
 *
 * `code` è un codice di autorizzazione ancora spendibile per ~10' se lo
 * scambio con Google fallisce dopo che Fastify ha già scritto la riga
 * "incoming request" (che parte PRIMA dell'handler, con `req.url` per
 * intero — query string inclusa — nel serializer di default). La difesa è
 * verificata a due livelli: la funzione pura che redige l'URL, e una vera
 * richiesta iniettata contro un logger che scrive su uno stream in memoria.
 */
describe("redactGoogleOauthCallbackUrl", () => {
  it("toglie code e state dalla query del callback, lasciando il resto", () => {
    const redacted = redactGoogleOauthCallbackUrl(
      "/api/me/google/callback?code=SEGRETO&state=abc123&extra=1",
    );
    expect(redacted).not.toContain("SEGRETO");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("code=");
    expect(redacted).not.toContain("state=");
    expect(redacted).toContain("extra=1");
    expect(redacted.startsWith("/api/me/google/callback?")).toBe(true);
  });

  it("lascia INTATTA la query di qualunque altro path", () => {
    const url = "/health?code=not-actually-secret&state=whatever";
    expect(redactGoogleOauthCallbackUrl(url)).toBe(url);
  });

  it("senza query string non tocca nulla", () => {
    expect(redactGoogleOauthCallbackUrl("/api/me/google/callback")).toBe(
      "/api/me/google/callback",
    );
  });

  it("senza code né state sul path del callback non tocca nulla", () => {
    const url = "/api/me/google/callback?error=access_denied";
    expect(redactGoogleOauthCallbackUrl(url)).toBe(url);
  });
});

describe("buildApp — log della richiesta al callback OAuth Google", () => {
  function capturingApp() {
    const lines: string[] = [];
    const app = buildApp({
      logger: {
        level: "info",
        stream: { write: (msg: string) => void lines.push(msg) },
      },
    });
    return { app, lines };
  }

  it("una richiesta reale al callback non scrive MAI il code in chiaro nel log", async () => {
    const { app, lines } = capturingApp();
    await app.inject({
      method: "GET",
      url: "/api/me/google/callback?code=SEGRETO&state=abc123",
    });
    const logged = lines.join("\n");
    expect(logged).not.toContain("SEGRETO");
    expect(logged).not.toContain("code=");
    expect(logged).not.toContain("state=");
  });

  it("una richiesta su un'altra rotta continua a loggare la query per intero", async () => {
    const { app, lines } = capturingApp();
    await app.inject({ method: "GET", url: "/health?foo=bar" });
    const logged = lines.join("\n");
    expect(logged).toContain("/health?foo=bar");
  });
});
