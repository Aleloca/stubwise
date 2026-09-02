import { gitProviderKindSchema, projectSchema } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * MIRROR di `repositorySummarySchema` (`apps/server/src/routes/projects.ts`):
 * quanto basta a elencare i repo di un progetto. La proiezione completa del
 * repository vive sotto `/api/repositories` e qui non serve.
 */
const repositorySummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  provider: gitProviderKindSchema,
});

/**
 * MIRROR di `projectListItemSchema` / `projectDetailSchema` (stesso file lato
 * server): il progetto condiviso (`projectSchema` di `@stubwise/shared`) più il
 * contorno che la lista e il dettaglio aggiungono. L'involucro non è in shared —
 * lo sono i campi che contiene.
 */
export const projectListItemSchema = projectSchema.extend({
  repositoryCount: z.number().int(),
});
export type ProjectListItem = z.infer<typeof projectListItemSchema>;

export const projectDetailSchema = projectSchema.extend({
  repositories: z.array(repositorySummarySchema),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

const projectListSchema = z.array(projectListItemSchema);

/**
 * Progetti visibili all'utente corrente.
 *
 * NOTA: `GET /api/projects/pulse` (il "polso" per progetto che l'app mostra in
 * lista) NON è qui: la rotta arriva con la fase B del programma.
 */
export function createProjectsEndpoints(request: ApiRequest) {
  return {
    list(): Promise<ProjectListItem[]> {
      return request("GET", "/api/projects", undefined, projectListSchema);
    },

    get(projectId: string): Promise<ProjectDetail> {
      return request("GET", `/api/projects/${seg(projectId)}`, undefined, projectDetailSchema);
    },
  };
}
