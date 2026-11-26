import { z } from "zod";
import type { DepartmentItem, ProjectStatusItem, TaskItem } from "../client.js";
import { errorResult, resolveProject, runTool, textResult } from "./shared.js";
import type { ToolDef, ToolResult } from "./types.js";

// Lotto 7, voce 4: l'MCP impara il vocabolario della nuova app — gli STATI
// per progetto (nome e famiglia), i REPARTI, le TAGLIE, i codici `<PRJ>-<n>`
// e `<PRJ>-R<n>` — e i filtri di `GET /api/tasks`. Solo lettura: gli stessi
// permessi del token, il server filtra. (La «Home» resta fuori, accettato:
// `my_requests` e `list_proposals` ne coprono la parte che serve qui.)

const SIZES = ["XS", "S", "M", "L", "XL"] as const;
const FAMILIES = ["todo", "active", "closed"] as const;

const list = z.union([z.array(z.string()), z.string()]).optional();
/** Accetta un array o una stringa separata da virgole. */
function names(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return raw.map((x) => String(x).trim()).filter((x) => x.length > 0);
}
const norm = (s: string) => s.trim().toLocaleLowerCase();

/** Risolve dei nomi in id (senza maiuscole); i nomi sconosciuti tornano a parte, per un errore che elenca i validi. */
function resolveNames<T extends { id: string; name: string }>(wanted: string[], all: readonly T[]): { ids: string[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const w of wanted) {
    const hit = all.find((x) => norm(x.name) === norm(w));
    if (hit) ids.push(hit.id);
    else unknown.push(w);
  }
  return { ids, unknown };
}

function taskLine(t: TaskItem, statuses: Map<string, ProjectStatusItem>, departments: Map<string, DepartmentItem>): string {
  const st = statuses.get(t.statusId);
  const parts = [
    `stato: ${st ? `${st.name} (${st.family})` : "?"}`,
    `reparto: ${departments.get(t.departmentId)?.name ?? "?"}`,
    `taglia: ${t.size ?? "—"}`,
    `priorità: ${t.priority}`,
  ];
  return `- ${t.code} ${t.title} [${parts.join(", ")}] (id: ${t.id})`;
}

// --- list_task_fields -----------------------------------------------------------

const listTaskFields: ToolDef = {
  name: "list_task_fields",
  description:
    "Il vocabolario delle task di un progetto: gli stati (nome e famiglia todo/active/closed, nell'ordine del progetto), i reparti e le taglie. Serve per filtrare con list_tasks usando i nomi giusti.",
  inputSchema: { project: z.string().optional().describe("Slug del progetto. Se omesso, usa il progetto collegato al repo corrente.") },
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const resolved = await resolveProject(args.project as string | undefined, ctx);
      if (!resolved.ok) return resolved.result;
      const [statuses, departments] = await Promise.all([ctx.client.listProjectStatuses(resolved.project.id), ctx.client.listDepartments()]);
      const st = [...statuses].sort((a, b) => a.position - b.position).map((s) => `- ${s.name} (${s.family})`);
      const dep = departments.map((d) => `- ${d.name}${d.isDefault ? " (predefinito)" : ""}`);
      return textResult(
        `Stati di '${resolved.project.slug}':\n${st.join("\n") || "- nessuno"}\n\nReparti:\n${dep.join("\n") || "- nessuno"}\n\nTaglie: ${SIZES.join(", ")} (o «none» per le task senza taglia).`,
      );
    }),
};

// --- list_tasks -------------------------------------------------------------------

const listTasks: ToolDef = {
  name: "list_tasks",
  description:
    "Elenca le task di un progetto con codice (es. ACQ-12), stato del progetto, reparto e taglia. Filtri opzionali: stati per NOME (quelli del progetto, vedi list_task_fields), famiglie (todo, active, closed), reparti per nome, taglie (XS, S, M, L, XL, none), assegnatario ('me' o 'none'), testo, ferme. Oltre 2000 task la lista è troncata e lo dice.",
  inputSchema: {
    project: z.string().optional().describe("Slug del progetto. Se omesso, usa il progetto collegato al repo corrente."),
    statuses: list.describe("Stati del progetto per nome (array o CSV), es. «In review»."),
    families: list.describe("Famiglie di stato: todo, active, closed."),
    departments: list.describe("Reparti per nome (array o CSV)."),
    sizes: list.describe("Taglie: XS, S, M, L, XL, none."),
    assignee: z.enum(["me", "none"]).optional().describe("'me' per le proprie, 'none' per quelle senza assegnatario."),
    text: z.string().max(500).optional().describe("Ricerca nel titolo e nella descrizione."),
    stalled: z.boolean().optional().describe("true: solo le ferme; false: solo quelle non ferme."),
  },
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const resolved = await resolveProject(args.project as string | undefined, ctx);
      if (!resolved.ok) return resolved.result;
      const [statuses, departments] = await Promise.all([ctx.client.listProjectStatuses(resolved.project.id), ctx.client.listDepartments()]);
      const st = resolveNames(names(args.statuses), statuses);
      const dep = resolveNames(names(args.departments), departments);
      const families = names(args.families).map(norm);
      const sizes = names(args.sizes).map((s) => (norm(s) === "none" ? "none" : s.trim().toUpperCase()));
      const badFamilies = families.filter((f) => !(FAMILIES as readonly string[]).includes(f));
      const badSizes = sizes.filter((s) => s !== "none" && !(SIZES as readonly string[]).includes(s));
      const problems = [
        st.unknown.length > 0 ? `stati sconosciuti: ${st.unknown.join(", ")} (validi: ${statuses.map((s) => s.name).join(", ")})` : null,
        dep.unknown.length > 0 ? `reparti sconosciuti: ${dep.unknown.join(", ")} (validi: ${departments.map((d) => d.name).join(", ")})` : null,
        badFamilies.length > 0 ? `famiglie sconosciute: ${badFamilies.join(", ")} (valide: ${FAMILIES.join(", ")})` : null,
        badSizes.length > 0 ? `taglie sconosciute: ${badSizes.join(", ")} (valide: ${SIZES.join(", ")}, none)` : null,
      ].filter((p): p is string => p !== null);
      if (problems.length > 0) return errorResult(`Filtri non validi per '${resolved.project.slug}': ${problems.join("; ")}.`);

      const page = await ctx.client.listTasks({
        projectIds: [resolved.project.id],
        ...(st.ids.length > 0 ? { statusIds: st.ids } : {}),
        ...(families.length > 0 ? { families: families as ("todo" | "active" | "closed")[] } : {}),
        ...(dep.ids.length > 0 ? { departmentIds: dep.ids } : {}),
        ...(sizes.length > 0 ? { sizes } : {}),
        ...(args.assignee ? { assigneeIds: [args.assignee as string] } : {}),
        ...(typeof args.text === "string" && args.text.length > 0 ? { text: args.text } : {}),
        ...(typeof args.stalled === "boolean" ? { stalled: args.stalled } : {}),
      });
      if (page.items.length === 0) return textResult(`Nessuna task per '${resolved.project.slug}' con questi filtri.`);
      const statusById = new Map(statuses.map((s) => [s.id, s]));
      const depById = new Map(departments.map((d) => [d.id, d]));
      const head = `Task di '${resolved.project.slug}' (${page.items.length}${page.truncated ? ", troncate: oltre il tetto del server; restringi i filtri" : ""}):`;
      return textResult(`${head}\n${page.items.map((t) => taskLine(t, statusById, depById)).join("\n")}`);
    }),
};

// --- get_by_code ------------------------------------------------------------------

/** Il prefisso del progetto da 2 a 6 caratteri, come il server (`automationOrigin`, i codici dei progetti). */
const CODE_RE = /^[A-Za-z][A-Za-z0-9]{1,5}-(R?)(\d{1,9})$/;

const getByCode: ToolDef = {
  name: "get_by_code",
  description:
    "Legge una task o una richiesta dal suo codice: «ACQ-12» è una task, «ACQ-R3» una richiesta (R<n>). Restituisce stato, reparto e taglia (task) o stato, urgenza e taglia (richiesta), con la descrizione.",
  inputSchema: { code: z.string().min(3).max(32).describe("Il codice, es. ACQ-12 o ACQ-R3.") },
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const code = String(args.code).trim().toUpperCase();
      const m = CODE_RE.exec(code);
      if (!m) return errorResult(`'${String(args.code)}' non è un codice: si scrive come ACQ-12 (task) o ACQ-R3 (richiesta).`);
      if (m[1] === "R") {
        const r = await ctx.client.getRequestByCode(code);
        const merged = r.mergedIntoCode ? `, unita in ${r.mergedIntoCode}` : "";
        return textResult(
          `Richiesta ${r.code}: ${r.title}\nstato: ${r.status}${merged}, urgenza: ${r.urgency ?? "—"}, taglia: ${r.size ?? "—"}, task collegate: ${r.taskIds?.length ?? 0} (id: ${r.id})\n\n${r.description || "(nessuna descrizione)"}`,
        );
      }
      const t = await ctx.client.getTaskByCode(code);
      const [statuses, departments] = await Promise.all([ctx.client.listProjectStatuses(t.projectId), ctx.client.listDepartments()]);
      const line = taskLine(t, new Map(statuses.map((s) => [s.id, s])), new Map(departments.map((d) => [d.id, d])));
      return textResult(`Task ${line.slice(2)}\n\n${t.description || "(nessuna descrizione)"}`);
    }),
};

export const taskTools: ToolDef[] = [listTaskFields, listTasks, getByCode];
