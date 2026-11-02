import { recordChange } from "../changelog/index";
import { writer } from "../writer";
import { managedProject, projectObject, refuse } from "./common";
import type { ProjectResult } from "./types";

// Progetto → Settings → General (area 9c, Task 2): il nome e la
// descrizione. Il codice non si cambia da qui (nessun campo). Si scrive con
// `project.settings.manage` nel progetto; ordine dei controlli di
// `common.ts`. Una voce per campo cambiato: `project.renamed` col nome di
// prima e di dopo (un nome dato da una persona si salva com'è),
// `project.description_changed` senza il testo (dice che è cambiata:
// scelta del controller).

/** Gli intervalli dello shape: nome 1–120 caratteri, descrizione 0–1000. */
export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 1000;

/** Cambia nome e descrizione; i campi assenti restano com'erano. */
export async function updateProjectGeneral(
  projectId: string,
  input: { name?: string; description?: string },
): Promise<ProjectResult> {
  return updateProjectGeneralAs(
    await writer("projectSettings.updateProjectGeneral"),
    projectId,
    input,
  );
}

/** La forma sincrona di `updateProjectGeneral` per chi ha già passato il cancello (il catalogo di Claude, area 10a). */
export function updateProjectGeneralAs(
  me: string,
  projectId: string,
  input: { name?: string; description?: string },
): ProjectResult {
  const managed = managedProject(me, projectId);
  if ("refusal" in managed) return managed.refusal;
  const { project } = managed;
  const name = input.name === undefined ? project.name : input.name.trim();
  if (!name || name.length > NAME_MAX) return refuse.invalid("name");
  const description =
    input.description === undefined ? (project.description ?? "") : input.description.trim();
  if (description.length > DESCRIPTION_MAX) return refuse.invalid("description");

  const before = { name: project.name, description: project.description ?? "" };
  project.name = name;
  project.description = description;
  if (before.name !== name)
    recordChange({
      kind: "project.renamed",
      actorId: me,
      projectId: project.id,
      object: projectObject(project),
      before: before.name,
      after: name,
    });
  if (before.description !== description)
    recordChange({
      kind: "project.description_changed",
      actorId: me,
      projectId: project.id,
      object: projectObject(project),
    });
  return { ok: true };
}
