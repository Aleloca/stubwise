import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

/**
 * La spec OpenAPI è derivata dagli schemi Zod delle route via
 * @fastify/swagger + jsonSchemaTransform di fastify-type-provider-zod.
 *
 * Scelta documentata: /health e la stessa /api/openapi.json NON compaiono
 * nella spec. Sono registrate direttamente sul root (fuori dai plugin), quindi
 * @fastify/swagger non le vede — ed è la scelta più semplice: sono endpoint
 * infrastrutturali, non parte dell'API documentata.
 */
describe("GET /api/openapi.json", () => {
  // buildApp senza db: la spec deve essere servibile senza database.
  const app = buildApp();

  it("risponde 200 con un documento OpenAPI 3.x", async () => {
    const res = await app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as { openapi: string; info: { title: string; version: string } };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe("Stubwise API");
    expect(spec.info.version).toBe("0.1.0");
  });

  it("contiene i path principali dell'API", async () => {
    const res = await app.inject({ method: "GET", url: "/api/openapi.json" });
    const spec = res.json() as { paths: Record<string, unknown> };
    expect(spec.paths).toHaveProperty("/api/tickets");
    expect(spec.paths).toHaveProperty("/api/projects");
    expect(spec.paths).toHaveProperty("/api/auth/login");
    // Documenta la scelta di esclusione degli endpoint infrastrutturali.
    expect(spec.paths).not.toHaveProperty("/health");
    expect(spec.paths).not.toHaveProperty("/api/openapi.json");
    // Le path della spec sono in forma canonica, senza slash finale.
    expect(spec.paths).not.toHaveProperty("/api/tickets/");
  });

  it("deriva il requestBody di POST /api/tickets dagli schemi Zod (title maxLength 300)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/openapi.json" });
    const spec = res.json() as {
      paths: Record<
        string,
        {
          post?: {
            requestBody?: {
              content: Record<
                string,
                { schema: { properties?: Record<string, { maxLength?: number }> } }
              >;
            };
          };
        }
      >;
    };
    const body = spec.paths["/api/tickets"]?.post?.requestBody;
    expect(body).toBeDefined();
    const schema = body?.content["application/json"]?.schema;
    expect(schema?.properties?.title).toBeDefined();
    expect(schema?.properties?.title?.maxLength).toBe(300);
  });

  it("descrive la risposta 200 di GET /api/tickets con items array", async () => {
    const res = await app.inject({ method: "GET", url: "/api/openapi.json" });
    const spec = res.json() as {
      paths: Record<
        string,
        {
          get?: {
            responses: Record<
              string,
              {
                content?: Record<
                  string,
                  {
                    schema: {
                      properties?: Record<string, { type?: string; items?: { type?: string } }>;
                    };
                  }
                >;
              }
            >;
          };
        }
      >;
    };
    const ok = spec.paths["/api/tickets"]?.get?.responses["200"];
    expect(ok).toBeDefined();
    const schema = ok?.content?.["application/json"]?.schema;
    expect(schema?.properties?.items?.type).toBe("array");
    expect(schema?.properties?.items?.items?.type).toBe("object");
  });

  it("la spec è strutturalmente coerente (info, paths, operazioni con responses)", async () => {
    // Validazione "a buon mercato" senza dipendenze extra: ogni operazione
    // dichiarata deve avere almeno una response documentata.
    const res = await app.inject({ method: "GET", url: "/api/openapi.json" });
    const spec = res.json() as {
      openapi: string;
      info: unknown;
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };
    expect(spec.info).toBeDefined();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
    const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!methods.has(method)) continue;
        expect(
          operation.responses && Object.keys(operation.responses).length,
          `${method.toUpperCase()} ${path} senza responses`,
        ).toBeTruthy();
      }
    }
  });
});
