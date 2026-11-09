import { z } from "zod";
import {
  periodFieldSchema,
  relativePeriodSchema,
  statusFamilySchema,
  taskSizeSchema,
  uiTaskTypeSchema,
} from "./task-view.js";
import { ticketPrioritySchema } from "./ticket.js";

/**
 * I criteri e i filtri salvati dell'app nuova (integrazione area 2, fetta 3).
 * `filterCriteriaSchema` è la FONTE della forma di `FilterCriteria` (il
 * prototipo, `apps/desktop/src/renderer/data/model.ts`): la valida il server
 * in scrittura, e `parseCriteria` ne è la versione tollerante per ciò che
 * arriva da fuori (un indirizzo scritto a mano o vecchio).
 *
 * Gli id sono stringhe, non uuid: lo stesso schema serve al finto, che ha id
 * come `prj-mkx`. Un id che non esiste semplicemente non trova niente.
 */

const idSchema = z.string().min(1).max(100);
const list = <T extends z.ZodType>(item: T) => z.array(item).max(200);

const periodSchema = z.discriminatedUnion("kind", [
  z.object({ field: periodFieldSchema, kind: z.literal("relative"), preset: relativePeriodSchema }),
  z.object({ field: periodFieldSchema, kind: z.literal("absolute"), from: z.iso.date(), to: z.iso.date() }),
]);

const criteriaShape = {
  projectIds: list(idSchema).optional(),
  departmentIds: list(idSchema).optional(),
  assigneeIds: list(idSchema).optional(),
  families: list(statusFamilySchema).optional(),
  statusIds: list(idSchema).optional(),
  sizes: list(z.union([taskSizeSchema, z.literal("none")])).optional(),
  milestoneIds: list(idSchema).optional(),
  types: list(uiTaskTypeSchema).optional(),
  priorities: list(ticketPrioritySchema).optional(),
  stalled: z.boolean().optional(),
  text: z.string().max(500).optional(),
  period: periodSchema.optional(),
};

export const filterCriteriaSchema = z.object(criteriaShape);
export type FilterCriteria = z.infer<typeof filterCriteriaSchema>;

/** Le chiavi che sono elenchi: si tengono gli elementi validi, un elenco vuoto si toglie. */
const LIST_ITEMS: Partial<Record<keyof FilterCriteria, z.ZodType>> = {
  projectIds: idSchema,
  departmentIds: idSchema,
  assigneeIds: idSchema,
  families: statusFamilySchema,
  statusIds: idSchema,
  sizes: z.union([taskSizeSchema, z.literal("none")]),
  milestoneIds: idSchema,
  types: uiTaskTypeSchema,
  priorities: ticketPrioritySchema,
};

/**
 * I criteri letti da fuori: si tiene ciò che ha la forma giusta e si scarta
 * il resto, chiave per chiave (negli elenchi, elemento per elemento), così un
 * indirizzo scritto a mano o vecchio non rompe la pagina. `null` se non è
 * nemmeno un oggetto.
 */
export function parseCriteria(raw: unknown): FilterCriteria | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(criteriaShape) as (keyof FilterCriteria)[]) {
    const value = input[key];
    if (value === undefined) continue;
    const item = LIST_ITEMS[key];
    if (item) {
      if (!Array.isArray(value)) continue;
      const kept = value.filter((v) => item.safeParse(v).success);
      if (kept.length) out[key] = kept;
      continue;
    }
    if (key === "text" && value === "") continue;
    const parsed = criteriaShape[key].safeParse(value);
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data;
  }
  return out as FilterCriteria;
}

export const filterVisibilitySchema = z.enum(["private", "public"]);
export const taskViewModeSchema = z.enum(["list", "board", "timeline"]);
export const taskGroupBySchema = z.enum(["none", "status", "assignee", "department", "milestone", "week", "project"]);

/** Un filtro salvato come lo vede chi guarda. `ownerId` null: un filtro di esempio, di nessuno. */
export const savedFilterViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  ownerId: z.uuid().nullable(),
  visibility: filterVisibilitySchema,
  /**
   * I criteri come li ha salvati il server (già passati da `parseCriteria`).
   * Sul filo sono un `record`, non `filterCriteriaSchema`: lo schema rigido ha
   * union ed enum che `readerSchema` non può aprire fedelmente, e un client
   * più vecchio di un criterio nuovo deve scartarlo, non fallire. Chi legge li
   * normalizza con `parseCriteria`, che tiene ciò che ha la forma giusta.
   */
  criteria: z.record(z.string(), z.unknown()),
  view: taskViewModeSchema,
  groupBy: taskGroupBySchema,
  /** Chi guarda può modificarlo ed eliminarlo (l'autore o un full admin): lo calcola il server. */
  canEdit: z.boolean().default(false),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SavedFilterView = z.infer<typeof savedFilterViewSchema>;

const filterNameSchema = z.string().trim().min(1).max(80);

/** Corpo di `POST /api/filters`. */
export const newFilterBodySchema = z.object({
  name: filterNameSchema,
  visibility: filterVisibilitySchema,
  criteria: filterCriteriaSchema,
  view: taskViewModeSchema,
  groupBy: taskGroupBySchema,
});
export type NewFilterBody = z.infer<typeof newFilterBodySchema>;

/** Corpo di `PATCH /api/filters/:id`: gli assenti restano invariati. */
export const filterPatchBodySchema = newFilterBodySchema.partial();
export type FilterPatchBody = z.infer<typeof filterPatchBodySchema>;
