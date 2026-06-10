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
});
