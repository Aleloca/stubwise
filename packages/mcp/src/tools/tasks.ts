import { addWeeks, currentIsoWeek, isIsoWeek, mondayToIsoWeek } from "./weeks.js";
import { z } from "zod";
import type { DepartmentItem, ProjectStatusItem, TaskItem } from "../client.js";
import { CLAUDE_ASSIGNED_LINE, resolveAssignee } from "./assignee.js";
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

// --- update_task -------------------------------------------------------------------
//
// Lotto 2 della parità (decisione di 46): una task per codice o per id, coi campi
// che si cambiano dall'app, in parole. Copre «sposta ACQ-12 a giovedì»: il GIORNO
// è la sistemazione personale di chi ha la task nella sua settimana
// (`PUT /api/tasks/:id/day`, 1–5), la SETTIMANA è un campo della task.

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** I giorni lavorativi in parole (italiano e inglese, con o senza accento) → 1–5; sabato e domenica → 6, 7. */
const WEEKDAYS: Record<string, number> = {
  lunedi: 1, lun: 1, monday: 1, mon: 1,
  martedi: 2, mar: 2, tuesday: 2, tue: 2,
  mercoledi: 3, mer: 3, wednesday: 3, wed: 3,
  giovedi: 4, gio: 4, thursday: 4, thu: 4,
  venerdi: 5, ven: 5, friday: 5, fri: 5,
  sabato: 6, sab: 6, saturday: 6, sat: 6,
  domenica: 7, dom: 7, sunday: 7, sun: 7,
};
const DAY_NAMES = ["", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"];

const plain = (s: string) => s.trim().toLocaleLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Il giorno della settimana ISO di una data AAAA-MM-GG (1 = lunedì … 7 = domenica). */
function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  return ((d.getUTCDay() + 6) % 7) + 1;
}

/** La settimana ISO (`2026-W49`) di una data AAAA-MM-GG: la regola dello shared (`@stubwise/shared`, tasks/weeks). */
export function isoWeekOf(date: string): string {
  return mondayToIsoWeek(date);
}

function validDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const updateTask: ToolDef = {
  name: "update_task",
  description:
    "Modifica una task per CODICE (es. ACQ-12) o per id: stato (per nome, quelli del progetto), assegnatario ('me', 'none', email o nome, anche «Claude»), settimana (ISO 2026-W49, una data, o 'none'), giorno (lunedì–venerdì, 1–5, una data, o 'none'), priorità (low, medium, high, urgent), reparto (per nome), taglia (XS–XL o 'none'). Cambia solo i campi dati. " +
    "«Sposta ACQ-12 a giovedì» è `day: \"giovedì\"`: il giorno vale nella settimana della task, ed è la sistemazione personale di chi ce l'ha in carico (solo l'assegnatario la imposta). " +
    "Assegnare l'utente «Claude» avvia il lavoro come `run_ticket`: serve `runs.start`, passa dal gate del piano e spende budget. Prima di chiamarlo di' all'utente in una riga cosa cambi e su quale task.",
  inputSchema: {
    task: z.string().min(3).max(64).describe("Il codice della task (ACQ-12) o il suo id."),
    status: z.string().min(1).max(100).optional().describe("Il nuovo stato, per nome (vedi list_task_fields)."),
    assignee: z.string().min(1).max(320).optional().describe("'me', 'none', l'email o il nome di una persona, o «Claude»."),
    week: z.string().min(1).max(20).optional().describe("La settimana pianificata: ISO (2026-W49), una data AAAA-MM-GG, o 'none' per toglierla."),
    day: z.union([z.string().min(1).max(20), z.number().int()]).optional().describe("Il giorno nella settimana: lunedì–venerdì, 1–5, una data AAAA-MM-GG, o 'none'."),
    priority: z.enum(PRIORITIES).optional().describe("La priorità."),
    department: z.string().min(1).max(100).optional().describe("Il reparto, per nome (vedi list_task_fields)."),
    size: z.string().min(1).max(5).optional().describe("La taglia: XS, S, M, L, XL o 'none'."),
  },
  handler: (args, ctx): Promise<ToolResult> =>
    runTool(async () => {
      const fields = ["status", "assignee", "week", "day", "priority", "department", "size"] as const;
      if (fields.every((f) => args[f] === undefined)) {
        return errorResult(`Per ${String(args.task)} non c'è niente da cambiare: dai almeno uno fra ${fields.join(", ")}.`);
      }

      // La task: per codice si legge intera, per id dal ticket (progetto) e, se serve, dalla risposta del PATCH.
      const raw = String(args.task).trim();
      let taskId: string;
      let projectId: string;
      let label: string;
      let plannedWeek: string | null | undefined;
      let taskAssignee: string | null;
      if (UUID_RE.test(raw)) {
        const ticket = await ctx.client.getTicket(raw);
        taskId = raw;
        projectId = ticket.projectId;
        taskAssignee = ticket.assigneeId;
        label = `la task ${raw}`;
      } else {
        const code = raw.toUpperCase();
        const m = CODE_RE.exec(code);
        if (!m || m[1] === "R") return errorResult(`'${raw}' non è il codice di una task: si scrive come ACQ-12 (o si dà l'id).`);
        const t = await ctx.client.getTaskByCode(code);
        taskId = t.id;
        projectId = t.projectId;
        label = t.code;
        taskAssignee = t.assigneeId;
        // È la settimana EFFETTIVA: il server la dà già slittata (`loadTaskViews`,
        // `stubwise_effective_week`), la stessa che controlla `PUT …/day`.
        plannedWeek = t.plannedWeek ?? null;
      }

      const problems: string[] = [];
      const patch: Record<string, unknown> = {};
      const said: string[] = [];

      if (args.status !== undefined) {
        const statuses = await ctx.client.listProjectStatuses(projectId);
        const hit = statuses.find((s) => norm(s.name) === norm(String(args.status)));
        if (hit) {
          patch.statusId = hit.id;
          said.push(`stato: ${hit.name}`);
        } else problems.push(`stato sconosciuto: ${String(args.status)} (validi: ${statuses.map((s) => s.name).join(", ")})`);
      }
      if (args.department !== undefined) {
        const departments = await ctx.client.listDepartments();
        const hit = departments.find((d) => norm(d.name) === norm(String(args.department)));
        if (hit) {
          patch.departmentId = hit.id;
          said.push(`reparto: ${hit.name}`);
        } else problems.push(`reparto sconosciuto: ${String(args.department)} (validi: ${departments.map((d) => d.name).join(", ")})`);
      }
      let claude = false;
      if (args.assignee !== undefined) {
        const a = await resolveAssignee(ctx, String(args.assignee));
        if (a.ok) {
          patch.assigneeId = a.id;
          claude = a.claude;
          said.push(`assegnatario: ${a.label}`);
        } else problems.push(a.problem);
      }
      if (args.priority !== undefined) {
        patch.priority = args.priority;
        said.push(`priorità: ${String(args.priority)}`);
      }
      if (args.size !== undefined) {
        const size = norm(String(args.size)) === "none" ? null : String(args.size).trim().toUpperCase();
        if (size !== null && !(SIZES as readonly string[]).includes(size)) problems.push(`taglia sconosciuta: ${String(args.size)} (valide: ${SIZES.join(", ")}, none)`);
        else {
          patch.size = size;
          said.push(`taglia: ${size ?? "nessuna"}`);
        }
      }

      // La settimana: data o ISO; `none` la toglie.
      let week: string | null | undefined;
      if (args.week !== undefined) {
        const w = String(args.week).trim();
        const now = currentIsoWeek(new Date());
        if (norm(w) === "none") week = null;
        else if (["this", "questa", "corrente"].includes(plain(w))) week = now;
        else if (["next", "prossima"].includes(plain(w))) week = addWeeks(now, 1);
        else if (isIsoWeek(w.toUpperCase())) week = w.toUpperCase();
        else if (validDate(w)) week = isoWeekOf(w);
        else problems.push(`settimana non valida: ${w} (si scrive 2026-W49, this, next, una data AAAA-MM-GG, oppure none)`);
      }

      // Il giorno: 1–5, un nome, una data (che dice anche la settimana), o `none`.
      let day: number | null | undefined;
      if (args.day !== undefined) {
        const d = String(args.day).trim();
        let n: number | null | undefined;
        if (norm(d) === "none") n = null;
        else if (/^\d$/.test(d)) n = Number(d);
        else if (validDate(d)) {
          n = isoWeekday(d);
          const fromDate = isoWeekOf(d);
          if (week !== undefined && week !== fromDate) problems.push(`il giorno ${d} non è nella settimana ${String(week)}`);
          week = fromDate;
        } else if (WEEKDAYS[plain(d)] !== undefined) n = WEEKDAYS[plain(d)];
        else problems.push(`giorno non valido: ${d} (lunedì–venerdì, 1–5, una data AAAA-MM-GG, o none)`);
        if (n !== undefined && n !== null && (n < 1 || n > 5)) problems.push(`${DAY_NAMES[n] || d} non è un giorno lavorativo: il giorno va da lunedì a venerdì`);
        else day = n;
      }

      // Una settimana data dall'utente si manda SEMPRE e decide il server: «questa
      // settimana» su una task slittata è già la sua settimana effettiva, ma va ripianificata.
      if (week !== undefined && (args.week !== undefined || week !== plannedWeek)) {
        patch.plannedWeek = week;
        said.push(`settimana: ${week ?? "nessuna"}`);
      }
      const dayWeek = week !== undefined ? week : plannedWeek;
      if (day !== undefined && dayWeek === undefined) {
        problems.push(`per mettere ${label} in un giorno serve la settimana: dalla col campo week, dai il giorno come data, o usa il codice della task`);
      } else if (day !== undefined && day !== null && dayWeek === null) {
        problems.push(`${label} non è pianificata in nessuna settimana: dalla col campo week, o dai il giorno come data`);
      }
      // Il giorno è la sistemazione di CHI HA la task: dopo il cambio, l'assegnatario dev'essere chi chiama.
      if (day !== undefined && problems.length === 0) {
        const me = await ctx.client.getMe();
        const after = "assigneeId" in patch ? (patch.assigneeId as string | null) : taskAssignee;
        if (after !== me.id) {
          problems.push(`il giorno lo sistema solo chi ha la task in carico, e ${label} ${after === null ? "non è assegnata a nessuno" : "non è assegnata a te"}: cambia l'assegnatario o lascia stare il giorno`);
        }
      }
      if (problems.length > 0) return errorResult(`Non cambio ${label}: ${problems.join("; ")}.`);

      let updated: { plannedWeek?: string | null } | undefined;
      if (Object.keys(patch).length > 0) updated = await ctx.client.patchTask(taskId, patch);
      if (day !== undefined) {
        const w = (week !== undefined ? week : (updated?.plannedWeek ?? plannedWeek)) as string;
        try {
          await ctx.client.setTaskDay(taskId, { week: w, day });
        } catch (err) {
          // I campi sono già scritti: si dice cosa è fatto e cosa no.
          const why = err instanceof Error ? err.message : String(err);
          const done = said.length > 0 ? `Aggiornata ${label}: ${said.join(", ")}; il giorno` : `Per ${label} il giorno`;
          return errorResult(`${done} NON è stato impostato: ${why}`);
        }
        said.push(day === null ? `giorno: nessuno (${w})` : `giorno: ${DAY_NAMES[day]} (${w})`);
      }
      const after = claude ? `\n${CLAUDE_ASSIGNED_LINE}` : "";
      return textResult(`Aggiornata ${label}: ${said.length > 0 ? said.join(", ") : "niente da cambiare, era già così"}.${after}`);
    }),
};

export const taskWriteTools: ToolDef[] = [updateTask];
