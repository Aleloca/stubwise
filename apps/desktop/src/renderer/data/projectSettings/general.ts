import { recordChange } from "../changelog/index";
import { encodeSwitch } from "../changelog/settingValues";
import type { ProjectModule } from "../model";
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

/** L'ordine dei moduli di un progetto, come li accende un modello (`TEMPLATE_MODULES`). */
const MODULE_ORDER: readonly ProjectModule[] = ["docs", "releases", "support", "servers"];

/**
 * L'interruttore «Docs» di General (area 11a, Q4): spento nasconde i Docs e
 * lo spazio Prodotto, e tiene le pagine (riacceso, ci sono). Si scrive con
 * `project.settings.manage`; una voce `project.docs_toggled` con «on»/«off»
 * di prima e di dopo, nessuna se non cambia nulla.
 */
export async function setDocsModule(projectId: string, on: boolean): Promise<ProjectResult> {
  return setDocsModuleAs(await writer("projectSettings.setDocsModule"), projectId, on);
}

/** La forma sincrona di `setDocsModule`, per chi ha già passato il cancello. */
export function setDocsModuleAs(me: string, projectId: string, on: boolean): ProjectResult {
  const managed = managedProject(me, projectId);
  if ("refusal" in managed) return managed.refusal;
  const { project } = managed;
  const before = project.modules.includes("docs");
  if (before === on) return { ok: true };
  const modules = new Set(project.modules);
  if (on) modules.add("docs");
  else modules.delete("docs");
  project.modules = MODULE_ORDER.filter((m) => modules.has(m));
  recordChange({
    kind: "project.docs_toggled",
    actorId: me,
    projectId: project.id,
    object: projectObject(project),
    before: encodeSwitch(before),
    after: encodeSwitch(on),
  });
  return { ok: true };
}
