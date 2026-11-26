import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../test/strangers";
import { getConversation, listConversations, resetApi, setLatency } from "./api";
import { setSessionPersonId } from "./session";
import { conversationRow, eventsOf, projectMasker, state, visibleProjectIds } from "./store";

// Registro, A11 r.1414, lotto 3 (conversazioni con Claude), nel prototipo:
// di una conversazione pubblica che chi guarda legge, il titolare, chi l'ha
// pubblicata e chi ha scritto i messaggi diventano `hidden-<n>` se non li
// conosce; un progetto che non vede (un'analisi di server letta con
// `monitor.manage`) diventa `hidden-project-<n>`, e la task non c'è.

const LAURA = "p-laura";
const CONV = "cv-giulia-callbacks";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("le conversazioni con Claude senza id di chi non si conosce (r.1414)", () => {
  it("una pubblica di uno sconosciuto: titolare, chi l'ha pubblicata, chi ha scritto", async () => {
    const c = state.conversations.find((x) => x.id === CONV)!;
    const [who] = strangersTo(LAURA);
    const owner = c.ownerId;
    c.ownerId = who!;
    c.publishedById = who!;
    for (const e of eventsOf(CONV))
      if (e.type === "user" && e.authorId === owner) e.authorId = who!;
    setSessionPersonId(LAURA);
    const row = (await listConversations({ scope: "public" } as never)).find((r) => r.id === CONV);
    const detail = (await getConversation(CONV))!;
    expect(detail).not.toBeNull();
    expect(detail.ownerId).toBe("hidden-1");
    expect(detail.publishedById).toBe("hidden-1");
    const users = detail.events.filter((e) => e.type === "user");
    expect(users.length).toBeGreaterThan(0);
    for (const e of users) if (e.type === "user") expect(e.authorId).toBe("hidden-1");
    expect(JSON.stringify(detail)).not.toContain(who!);
    if (row) expect(row.ownerId).toBe("hidden-1");
  });

  it("un progetto che chi guarda non vede: `hidden-project-<n>`, e niente task", () => {
    const visible = visibleProjectIds(LAURA);
    const hiddenProject = state.projects.find((p) => !visible.has(p.id))!;
    const task = state.tasks.find((t) => t.projectId === hiddenProject.id)!;
    const c = {
      ...state.conversations.find((x) => x.id === CONV)!,
      projectId: hiddenProject.id,
      taskId: task.id,
      ownerId: LAURA,
    };
    const row = conversationRow(LAURA, c);
    expect(row.projectId).toBe("hidden-project-1");
    expect(row.taskId).toBeNull();
    expect(JSON.stringify(row)).not.toContain(hiddenProject.id);
  });
});

it("due progetti che chi guarda non vede, nello stesso elenco: due segnaposti, uno per progetto", () => {
  const visible = visibleProjectIds(LAURA);
  const [p1, p2] = state.projects.filter((p) => !visible.has(p.id));
  expect(p1 && p2).toBeTruthy();
  const base = state.conversations.find((x) => x.id === CONV)!;
  const mask = projectMasker(LAURA);
  const rows = [p1!, p2!, p1!].map((p) =>
    conversationRow(LAURA, { ...base, projectId: p.id, ownerId: LAURA }, (id) => id, mask),
  );
  expect(rows.map((r) => r.projectId)).toEqual([
    "hidden-project-1",
    "hidden-project-2",
    "hidden-project-1",
  ]);
});
