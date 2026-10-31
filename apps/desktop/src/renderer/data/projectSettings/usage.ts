import { usageView, type UsageDimension, type UsageRange, type UsageView } from "../instance/usage";
import { gate } from "../store";
import { forbidden } from "../writer";
import { canI } from "./common";
import { openProject } from "./reads";

// Progetto → Settings → Usage (area 9c, Task 2): il calcolo della scheda
// Usage d'istanza (`usageView`) con il solo progetto. Si legge con
// `project.usage.view` nel progetto; l'istanza non cambia regola
// (`usage.view` resta d'istanza). Un progetto invisibile o archiviato è
// `null` (R-G5; ruling del controller (pre-flight), P14), senza permesso è
// `forbidden`. Non si raggruppa per progetto: ce n'è uno.

export type ProjectUsageDimension = Exclude<UsageDimension, "project">;

/** I consumi del progetto nell'intervallo, raggruppati come nella scheda d'istanza. */
export async function getProjectUsage(
  projectId: string,
  input: { range: UsageRange; groupBy: ProjectUsageDimension; thenBy?: ProjectUsageDimension },
): Promise<UsageView | null> {
  const me = await gate("projectSettings.getProjectUsage");
  const project = openProject(me, projectId);
  if (!project) return null;
  if (!canI(me, "project.usage.view", project.id)) throw forbidden();
  return usageView(me, input, project.id);
}
