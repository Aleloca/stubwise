import { recordChange } from "../changelog/index";
import { encodeAiAccount } from "../changelog/settingValues";
import { state } from "../store";
import { writer } from "../writer";
import { managedProject, projectObject, refuse } from "./common";
import { settingsOf } from "./reads";
import type { ProjectResult } from "./types";

// Progetto → Settings → AI (area 9c, Task 2): con quale account dell'istanza
// lavora Claude sul progetto. `null` = «Automatic» (la catena); con un
// account, `exclusive` dice se il progetto usa SOLO quello. Chi parte con
// chi lo decide `pickProvider(projectId)` (`instance/blocks.ts`). La voce
// salva valori stabili (`auto`, `account:<id>[:exclusive]`): il nome
// dell'account lo risolve la lettura del registro.

/** Sceglie l'account del progetto (`project.settings.manage`). */
export async function setProjectAi(
  projectId: string,
  input: { providerId: string | null; exclusive: boolean },
): Promise<ProjectResult> {
  return setProjectAiAs(await writer("projectSettings.setProjectAi"), projectId, input);
}

/** La forma sincrona di `setProjectAi` per chi ha già passato il cancello (il catalogo di Claude, area 10a). */
export function setProjectAiAs(
  me: string,
  projectId: string,
  input: { providerId: string | null; exclusive: boolean },
): ProjectResult {
  const managed = managedProject(me, projectId);
  if ("refusal" in managed) return managed.refusal;
  const { project } = managed;
  const { providerId } = input;
  const exclusive = input.exclusive === true;
  if (providerId !== null && !state.instance.providers.some((p) => p.id === providerId))
    return refuse.invalid("provider");
  if (providerId === null && exclusive) return refuse.invalid("exclusive_needs_account");

  const settings = settingsOf(project);
  // Il nome di allora di ciascun account (un nome dato da una persona, si
  // salva com'è): eliminato l'account, la voce dice ancora «Backup Max (deleted)».
  const nameOf = (id: string | null) =>
    id === null ? undefined : state.instance.providers.find((p) => p.id === id)?.name;
  const names: Record<string, string> = {};
  const beforeName = nameOf(settings.aiProviderId);
  const afterName = nameOf(providerId);
  if (beforeName !== undefined) names.accountBefore = beforeName;
  if (afterName !== undefined) names.accountAfter = afterName;
  const before = encodeAiAccount(settings.aiProviderId, settings.aiProviderExclusive);
  const after = encodeAiAccount(providerId, exclusive);
  settings.aiProviderId = providerId;
  settings.aiProviderExclusive = exclusive;
  // Un salvataggio che non cambia niente non scrive voci.
  if (before !== after)
    recordChange({
      kind: "project.ai_account_changed",
      actorId: me,
      projectId: project.id,
      object: projectObject(project),
      before,
      after,
      params: names,
    });
  return { ok: true };
}
