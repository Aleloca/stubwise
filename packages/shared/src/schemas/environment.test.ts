import { describe, expect, it } from "vitest";
import {
  createEnvironmentSchema,
  patchEnvironmentSchema,
  projectEnvironmentSchema,
} from "./environment.js";

describe("projectEnvironmentSchema", () => {
  const BASE = {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    name: "staging",
    kind: "staging" as const,
    url: "https://staging.acme.test",
    serverId: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };

  it("parsa una risposta completa", () => {
    expect(
      projectEnvironmentSchema.parse({
        ...BASE,
        runningImage: "acme/web:1.2.3",
        runningCommitSha: "abc1234",
      }),
    ).toMatchObject({ runningImage: "acme/web:1.2.3", runningCommitSha: "abc1234" });
  });

  it("parsa SENZA runningImage/runningCommitSha (Task 4: un server non collegato, o un agente vecchio)", () => {
    const parsed = projectEnvironmentSchema.parse(BASE);
    expect(parsed.runningImage).toBeUndefined();
    expect(parsed.runningCommitSha).toBeUndefined();
  });

  it("url e serverId nullable", () => {
    expect(
      projectEnvironmentSchema.parse({ ...BASE, url: null, serverId: null }),
    ).toMatchObject({ url: null, serverId: null });
  });
});

describe("createEnvironmentSchema", () => {
  it("richiede name e kind", () => {
    expect(() => createEnvironmentSchema.parse({ kind: "test" })).toThrow();
    expect(() => createEnvironmentSchema.parse({ name: "x" })).toThrow();
  });

  it("url/serverId opzionali", () => {
    const parsed = createEnvironmentSchema.parse({ name: "test", kind: "test" });
    expect(parsed).toMatchObject({ name: "test", kind: "test" });
  });
});

describe("patchEnvironmentSchema", () => {
  it("ammette un body vuoto (nessun campo cambia)", () => {
    expect(patchEnvironmentSchema.parse({})).toEqual({});
  });

  it("non accetta kind (non modificabile via patch)", () => {
    const parsed = patchEnvironmentSchema.parse({ name: "x", kind: "production" });
    expect(parsed).not.toHaveProperty("kind");
  });
});
