import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { drive } from "./drive";
import { installFakeServer, PROJECT_ID } from "./fakeServer";
import { saveFilter, updateFilter } from "./filters";
import { listStalled, listTasks } from "./tasks";

// Registro, A11 r.1414: i segnaposto `hidden-<n>` nella build app (72,
// 188ecb996). Un filtro salvato si esegue col suo id (`savedFilterId`), che
// il server usa per i segnaposto di `assigneeIds`; un segnaposto dove il
// server vuole una persona è 400 `invalid`, col campo in testa al messaggio
// («criteria: …», «addedById: …»), che qui diventa l'errore del prototipo
// (`invalid: criteria`, `invalid: addedById`).

const FILTER = "88888888-8888-4888-8888-888888888888";
const invalid = (field: string) => ({
  status: 400,
  body: { code: "invalid", message: `${field}: a placeholder is not a person id` },
});

beforeEach(() => setAppClientForTests(null));
afterEach(() => {
  vi.unstubAllGlobals();
  setAppClientForTests(null);
});

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );

describe("i segnaposto nella build app", () => {
  it("un filtro salvato si esegue col suo id: le task e il lavoro fermo", async () => {
    const { seen } = installFakeServer({
      "GET /api/tasks": { body: { items: [] } },
      "GET /api/tasks/stalled": { body: [] },
    });
    const criteria = { assigneeIds: ["hidden-1", "none"], savedFilterId: FILTER };
    await listTasks(criteria);
    await listStalled(criteria);
    const paths = seen.map((r) => r.path);
    expect(paths.find((p) => p.startsWith("/api/tasks?"))).toContain(`savedFilterId=${FILTER}`);
    expect(paths.find((p) => p.startsWith("/api/tasks/stalled"))).toContain(
      `savedFilterId=${FILTER}`,
    );
  });

  it("un segnaposto senza il filtro: `invalid: criteria`, come il prototipo", async () => {
    installFakeServer({
      "GET /api/tasks": invalid("criteria"),
      "GET /api/tasks/stalled": invalid("criteria"),
    });
    expect(await errorOf(listTasks({ assigneeIds: ["hidden-1"] }))).toBe("invalid: criteria");
    expect(await errorOf(listStalled({ assigneeIds: ["hidden-1"] }))).toBe("invalid: criteria");
  });

  it("salvare o modificare un filtro con un segnaposto: `invalid: criteria`", async () => {
    installFakeServer({
      "POST /api/filters": invalid("criteria"),
      [`PATCH /api/filters/${FILTER}`]: invalid("criteria"),
    });
    const criteria = { assigneeIds: ["hidden-2"] };
    expect(
      await errorOf(
        saveFilter({
          name: "Mine",
          visibility: "private",
          criteria,
          view: "list",
          groupBy: "none",
        }),
      ),
    ).toBe("invalid: criteria");
    expect(await errorOf(updateFilter(FILTER, { criteria }))).toBe("invalid: criteria");
  });

  // Revisione I-6 (72, f0d312736): «Salva come» manda il filtro d'origine a parte, non nei criteri.
  it("«Salva come» manda l'origine (`savedFilterId`), e i criteri senza", async () => {
    const { seen } = installFakeServer({
      "POST /api/filters": {
        body: {
          id: "99999999-9999-4999-8999-999999999999",
          name: "Loro",
          ownerId: null,
          visibility: "private",
          criteria: { assigneeIds: ["hidden-1"] },
          view: "list",
          groupBy: "none",
          canEdit: true,
          createdAt: "2026-11-23T10:00:00.000Z",
          updatedAt: "2026-11-23T10:00:00.000Z",
        },
      },
    });
    await saveFilter({
      name: "Loro",
      visibility: "private",
      criteria: { assigneeIds: ["hidden-1"] },
      view: "list",
      groupBy: "none",
      savedFilterId: FILTER,
    });
    expect(seen.find((r) => r.method === "POST")!.body).toMatchObject({
      savedFilterId: FILTER,
      criteria: { assigneeIds: ["hidden-1"] },
    });
    expect((seen.find((r) => r.method === "POST")!.body as { criteria: object }).criteria).not.toHaveProperty(
      "savedFilterId",
    );
  });

  it("il Drive filtrato per un segnaposto: `invalid: addedById`, su tutt'e due gli elenchi", async () => {
    installFakeServer({
      [`GET /api/projects/${PROJECT_ID}/drive/files`]: invalid("addedById"),
      "GET /api/drive/files": invalid("addedById"),
    });
    expect(
      await errorOf(
        drive.listDriveFiles({ projectId: PROJECT_ID, addedById: "hidden-1", sort: "recent" }),
      ),
    ).toBe("invalid: addedById");
    expect(await errorOf(drive.listDriveFiles({ addedById: "hidden-1", sort: "recent" }))).toBe(
      "invalid: addedById",
    );
  });

  it("un altro 400 resta com'è", async () => {
    installFakeServer({
      "GET /api/tasks": { status: 400, body: { code: "bad_query", message: "x" } },
    });
    expect(await errorOf(listTasks({}))).not.toMatch(/^invalid: /);
  });
});
