import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { productPages, projects } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Il modulo Docs spento chiude le rotte (registro dei rimandi, area 11): con
 * `projects.modules` senza `docs` le rotte dei Docs dei repository E dello
 * spazio Product rispondono 404, come un progetto invisibile, a chiunque —
 * anche a un full admin. Gli elenchi d'istanza non nominano più il progetto.
 * Ogni caso ha il suo controllo col modulo acceso, e le scritture asseriscono
 * anche lo stato.
 */

let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = { headers: { cookie: string } };
let editor: U;
let admin: U;
let projectId: string;
let repositoryId: string;
let page: { id: string; code: string };

const inject = (who: U, method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload !== undefined ? { payload: payload as never } : {}) });
const setModules = (modules: ("docs" | "releases" | "support" | "servers")[]) => t.db.update(projects).set({ modules }).where(eq(projects.id, projectId));

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  const users = await seedUsers(app);
  admin = { headers: { cookie: users.adminCookie } };
  ({ projectId, repositoryId } = await seedRepository(t.db));
  editor = await createUserWithSession(app, "editor-mod@example.com");
  await addMember(app, projectId, (editor as unknown as { id: string }).id, "developer");
  const res = await inject(editor, "POST", `/api/projects/${projectId}/product/pages`, { title: "Visione" });
  expect(res.statusCode, res.body).toBe(201);
  page = res.json() as { id: string; code: string };
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const reads = () => [
  `/api/projects/${projectId}/product`,
  `/api/product-pages/by-code/${page.code}`,
  `/api/product-pages/${page.id}/revisions`,
  `/api/product-changes?projectId=${projectId}`,
  `/api/projects/${projectId}/docs/spaces`,
  `/api/repositories/${repositoryId}/docs/status`,
  `/api/repositories/${repositoryId}/docs/tree`,
];

describe("il modulo Docs spento", () => {
  it("col modulo acceso le letture rispondono (il controllo del caso negativo)", async () => {
    await setModules(["docs", "releases"]);
    for (const who of [editor, admin]) {
      for (const url of reads()) {
        const res = await inject(who, "GET", url);
        expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
      }
    }
  });

  it("spento: ogni lettura dei Docs e del Product è 404, anche per un full admin", async () => {
    await setModules(["releases", "support"]);
    try {
      for (const who of [editor, admin]) {
        for (const url of reads()) {
          const res = await inject(who, "GET", url);
          expect({ url, status: res.statusCode, code: (res.json() as { code?: string }).code }).toEqual({ url, status: 404, code: "not_found" });
        }
      }
    } finally {
      await setModules(["docs", "releases", "support", "servers"]);
    }
  });

  it("spento: le scritture sono 404 e non cambiano niente", async () => {
    await setModules([]);
    try {
      const before = await t.db.select({ id: productPages.id }).from(productPages).where(eq(productPages.projectId, projectId));
      for (const who of [editor, admin]) {
        expect((await inject(who, "POST", `/api/projects/${projectId}/product/pages`, { title: "No" })).statusCode).toBe(404);
        expect((await inject(who, "PATCH", `/api/product-pages/${page.id}`, { title: "Rinominata" })).statusCode).toBe(404);
      }
      expect(await t.db.select({ id: productPages.id }).from(productPages).where(eq(productPages.projectId, projectId))).toEqual(before);
      expect((await t.db.select({ title: productPages.title }).from(productPages).where(eq(productPages.id, page.id)))[0]!.title).toBe("Visione");
    } finally {
      await setModules(["docs", "releases", "support", "servers"]);
    }
  });

  it("spento: gli elenchi d'istanza non nominano il progetto (hub dei Docs, cambi della doc)", async () => {
    const hub = async (who: U) => ((await inject(who, "GET", "/api/docs/spaces")).json() as { repositoryId: string }[]).map((s) => s.repositoryId);
    const changes = async (who: U) => JSON.stringify((await inject(who, "GET", "/api/product-changes")).json());
    for (const who of [editor, admin]) {
      expect(await hub(who)).toContain(repositoryId);
      expect(await changes(who)).toContain(page.id);
    }
    await setModules(["releases"]);
    try {
      for (const who of [editor, admin]) {
        expect(await hub(who)).not.toContain(repositoryId);
        expect(await changes(who)).not.toContain(page.id);
      }
    } finally {
      await setModules(["docs", "releases", "support", "servers"]);
    }
  });
});
