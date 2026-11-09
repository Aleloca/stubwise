import { z } from "zod";

/**
 * La Home a blocchi sul filo (integrazione area 2, fetta 3). Il `kind` di un
 * blocco è APERTO: un kind che il client non conosce passa e il client lo
 * ignora (un blocco di un'area non ancora integrata, o di una versione più
 * nuova). Le regole stanno in `tasks/home.ts`.
 */
export const homeBlockSchema = z
  .object({
    kind: z.string().min(1).max(64),
    filterId: z.string().min(1).max(100).optional(),
  })
  .refine((b) => b.kind !== "filter" || b.filterId !== undefined, {
    message: "a filter block needs its filterId",
    path: ["filterId"],
  });
export type HomeBlock = z.infer<typeof homeBlockSchema>;

/** Corpo di `PUT /api/me/home` e `PUT /api/departments/:id/home`. */
export const setHomeBodySchema = z.object({ blocks: z.array(homeBlockSchema).max(50) });
export type SetHomeBody = z.infer<typeof setHomeBodySchema>;

/** Un blocco in una risposta: senza i controlli di scrittura (li ha già fatti il server). */
const homeBlockViewSchema = z.object({ kind: z.string(), filterId: z.string().optional() });

export const departmentHomeViewSchema = z.object({
  departmentId: z.uuid(),
  blocks: z.array(homeBlockViewSchema),
  /** null: il reparto non ha (ancora) una Home sua. */
  updatedAt: z.iso.datetime().nullable(),
  updatedById: z.uuid().nullable().default(null),
});
export type DepartmentHomeView = z.infer<typeof departmentHomeViewSchema>;

export const personalHomeViewSchema = z.object({
  blocks: z.array(homeBlockViewSchema),
  seenDepartmentUpdates: z.record(z.string(), z.string()),
});
export type PersonalHomeView = z.infer<typeof personalHomeViewSchema>;

/** `GET /api/me/home`: la Home già risolta per chi guarda, e ciò che serve a personalizzarla. */
export const meHomeViewSchema = z.object({
  blocks: z.array(homeBlockViewSchema),
  /** I reparti la cui Home è cambiata dopo l'ultima vista (solo con la Home personale). */
  departmentChanged: z.array(z.uuid()).default([]),
  /** «Vedi le novità»: i blocchi di quelle Home che la mia non ha. */
  newBlocks: z.array(homeBlockViewSchema).default([]),
  /** I reparti di chi guarda, nell'ordine in cui contano, con la loro Home. */
  departmentIds: z.array(z.uuid()).default([]),
  departmentHomes: z.array(departmentHomeViewSchema).default([]),
  /** null: usa l'unione delle Home dei suoi reparti. */
  personal: personalHomeViewSchema.nullable(),
});
export type MeHomeView = z.infer<typeof meHomeViewSchema>;

/** Un ruolo di reparto: i permessi di REPARTO di una persona su un reparto. */
export const departmentRoleViewSchema = z.object({
  departmentId: z.uuid(),
  userId: z.uuid(),
  permissions: z.array(z.string()),
});
export type DepartmentRoleView = z.infer<typeof departmentRoleViewSchema>;
