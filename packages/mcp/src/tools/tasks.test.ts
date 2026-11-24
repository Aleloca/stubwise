import { describe, expect, it, vi } from "vitest";
import { StubwiseApiError, type StubwiseClient } from "../client.js";
import { taskTools } from "./tasks.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

// Lotto 7, voce 4: stati, reparti, taglie, codici e filtri della nuova app.

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ST_TODO = "11111111-1111-4111-8111-111111111111";
const ST_REVIEW = "22222222-2222-4222-8222-222222222222";
const DEP = "33333333-3333-4333-8333-333333333333";
const project = { id: PROJECT_ID, slug: "acq", name: "Acquisti" };
const statuses = [
  { id: ST_REVIEW, name: "In review", family: "active", position: 2 },
  { id: ST_TODO, name: "Da fare", family: "todo", position: 1 },
];
const departments = [{ id: DEP, name: "Design", isDefault: false }];
const task = { id: "t-1", code: "ACQ-12", projectId: PROJECT_ID, title: "Il bottone", description: "Corpo", statusId: ST_REVIEW, departmentId: DEP, size: "M", priority: "high", type: "task", assigneeId: null };

// Il doppio del client: OGNI metodo che i tool chiamano (regola del CLAUDE.md sui doppi parziali).
function makeClient() {
  return {
    listProjects: vi.fn().mockResolvedValue([project]),
    getProjectBySlug: vi.fn().mockResolvedValue(project),
    listProjectStatuses: vi.fn().mockResolvedValue(statuses),
    listDepartments: vi.fn().mockResolvedValue(departments),
    listTasks: vi.fn().mockResolvedValue({ items: [task], truncated: false }),
    getTaskByCode: vi.fn().mockResolvedValue(task),
    getRequestByCode: vi.fn(),
  };
}
const ctxOf = (client: ReturnType<typeof makeClient>): ToolContext => ({
  client: client as unknown as StubwiseClient,
  config: { baseUrl: "https://s.example.com", token: "stw_pat_x", projectSlug: null },
});
const tool = (name: string): ToolDef => taskTools.find((t) => t.name === name)!;
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

describe("list_task_fields", () => {
  it("gli stati nell'ordine del progetto con la famiglia, i reparti e le taglie", async () => {
    const res = await tool("list_task_fields").handler({ project: "acq" }, ctxOf(makeClient()));
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("- Da fare (todo)\n- In review (active)");
    expect(text(res)).toContain("- Design");
    expect(text(res)).toContain("XS, S, M, L, XL");
  });
});

describe("list_tasks", () => {
  it("i nomi si risolvono in id (senza maiuscole) e i filtri arrivano al server; la riga dice stato, reparto e taglia", async () => {
    const client = makeClient();
    const res = await tool("list_tasks").handler({ project: "acq", statuses: "in review", departments: ["DESIGN"], sizes: "m,none", families: ["Active"], assignee: "me", stalled: false }, ctxOf(client));
    expect(client.listTasks).toHaveBeenCalledWith({
      projectIds: [PROJECT_ID],
      statusIds: [ST_REVIEW],
      families: ["active"],
      departmentIds: [DEP],
      sizes: ["M", "none"],
      assigneeIds: ["me"],
      stalled: false,
    });
    expect(text(res)).toContain("- ACQ-12 Il bottone [stato: In review (active), reparto: Design, taglia: M, priorità: high]");
  });

  it("un nome sconosciuto è un errore che elenca i validi, e non si chiama la lista", async () => {
    const client = makeClient();
    const res = await tool("list_tasks").handler({ project: "acq", statuses: "Fatto", sizes: "XXL" }, ctxOf(client));
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("stati sconosciuti: Fatto (validi: In review, Da fare)");
    expect(text(res)).toContain("taglie sconosciute: XXL");
    expect(client.listTasks).not.toHaveBeenCalled();
  });

  it("una lista troncata dal server lo dice", async () => {
    const client = makeClient();
    client.listTasks.mockResolvedValue({ items: [task], truncated: true });
    expect(text(await tool("list_tasks").handler({ project: "acq" }, ctxOf(client)))).toContain("troncate");
  });
});

describe("get_by_code", () => {
  it("ACQ-12 è una task: stato, reparto, taglia e descrizione", async () => {
    const client = makeClient();
    const res = await tool("get_by_code").handler({ code: "acq-12" }, ctxOf(client));
    expect(client.getTaskByCode).toHaveBeenCalledWith("ACQ-12");
    expect(text(res)).toContain("Task ACQ-12 Il bottone [stato: In review (active), reparto: Design, taglia: M");
    expect(text(res)).toContain("Corpo");
  });

  it("ACQ-R3 è una richiesta (R<n>), anche unita in un'altra", async () => {
    const client = makeClient();
    client.getRequestByCode.mockResolvedValue({ id: "r-3", code: "ACQ-R3", projectId: PROJECT_ID, title: "Esporta", description: "", status: "merged", urgency: "high", size: null, taskIds: [], mergedIntoCode: "ACQ-R1" });
    const res = await tool("get_by_code").handler({ code: "ACQ-R3" }, ctxOf(client));
    expect(client.getTaskByCode).not.toHaveBeenCalled();
    expect(text(res)).toContain("Richiesta ACQ-R3: Esporta\nstato: merged, unita in ACQ-R1, urgenza: high");
  });

  it("un codice malformato non chiama il server; un 404 diventa un errore leggibile", async () => {
    const client = makeClient();
    expect((await tool("get_by_code").handler({ code: "12-ACQ" }, ctxOf(client))).isError).toBe(true);
    expect(client.getTaskByCode).not.toHaveBeenCalled();
    client.getTaskByCode.mockRejectedValue(new StubwiseApiError("Task not found", 404, "not_found"));
    expect((await tool("get_by_code").handler({ code: "ACQ-99" }, ctxOf(client))).isError).toBe(true);
  });
});
