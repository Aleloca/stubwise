import { describe, it, expect } from "vitest";
import { buildApp } from "./app.js";

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
    expect(res.json()).toEqual({ message: "Errore interno" });
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
