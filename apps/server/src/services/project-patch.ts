import { aiProviders, projects, type Db } from "@stubwise/db";
import { MODULE_ORDER, type ProjectModule, type UpdateProjectInput } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { isUniqueViolation } from "../routes/shared.js";
import type { ChangeInput } from "./change-log.js";
import { recordProjectChanges } from "./project-settings-log.js";

type ProjectRow = typeof projects.$inferSelect;

/** I moduli una volta sola, nell'ordine in cui un progetto li elenca (`MODULE_ORDER`). */
export function orderedModules(modules: readonly ProjectModule[]): ProjectModule[] {
  return MODULE_ORDER.filter((m) => modules.includes(m));
}

export type PatchProjectResult =
  | { ok: true; row: ProjectRow }
  | { ok: false; error: "not_found" | "pulse_needs_backlog" | "code_taken" | "ai_provider_not_found" };

/**
 * Il `PATCH /api/projects/:projectId` (area 9, F7: estratto dalla rotta perché
 * lo chiamano anche le azioni di Claude, `updateProjectGeneral`,
 * `setProjectAi`, `saveProjectAutomations`). Lettura, regola del pulse,
 * scrittura e voci del registro nella STESSA transazione, con la riga
 * bloccata (area 9, F5): due salvataggi si mettono in fila.
 */
export async function patchProject(db: Db, actor: ChangeInput["actor"], projectId: string, body: UpdateProjectInput): Promise<PatchProjectResult> {
  const {
    name,
    description,
    aiProviderId,
    aiProviderExclusive,
    docAutoUpdate,
    dailyReportEnabled,
    backlogEnabled,
    pulseEnabled,
    pulseEveryDays,
    weeklyBriefEnabled,
    prCorrectionMaxRounds,
    code,
    clientName,
    modules,
  } = body;
  const updates: Partial<ProjectRow> = {};
  // Fetta 4: null toglie il cliente (torna interno); i moduli sono l'insieme intero.
  if (clientName !== undefined) updates.clientName = clientName;
  if (modules !== undefined) updates.modules = orderedModules(modules);
  if (name !== undefined) updates.name = name;
  // Codice di progetto (integrazione area 2): unico, 409 se è di un altro.
  if (code !== undefined) updates.code = code;
  // null azzera la descrizione, una stringa la imposta; omesso lascia.
  if (description !== undefined) updates.description = description;
  // I toggle e la cadenza: omessi restano invariati. I range li ha già
  // applicati lo schema del corpo (400), e il CHECK del DB resta l'arbitro
  // per chi scrive senza passare da qui.
  if (docAutoUpdate !== undefined) updates.docAutoUpdate = docAutoUpdate;
  if (dailyReportEnabled !== undefined) updates.dailyReportEnabled = dailyReportEnabled;
  if (backlogEnabled !== undefined) updates.backlogEnabled = backlogEnabled;
  if (pulseEnabled !== undefined) updates.pulseEnabled = pulseEnabled;
  if (pulseEveryDays !== undefined) updates.pulseEveryDays = pulseEveryDays;
  if (weeklyBriefEnabled !== undefined) updates.weeklyBriefEnabled = weeklyBriefEnabled;
  if (prCorrectionMaxRounds !== undefined) updates.prCorrectionMaxRounds = prCorrectionMaxRounds;
  // Provider AI del progetto (Docs e fix). null lo azzera (automatico); un
  // uuid deve riferire una riga ai_providers esistente; omesso lo lascia.
  if (aiProviderId !== undefined) {
    if (aiProviderId !== null) {
      const [aiProvider] = await db.select({ id: aiProviders.id }).from(aiProviders).where(eq(aiProviders.id, aiProviderId));
      if (!aiProvider) return { ok: false, error: "ai_provider_not_found" };
    }
    updates.aiProviderId = aiProviderId;
    // Provider tolto: «solo questo» non sopravvive, qualunque cosa dica il body.
    if (aiProviderId === null) updates.aiProviderExclusive = false;
  }
  // «Solo questo» vale solo con un provider (nel body o già in colonna).
  if (aiProviderExclusive !== undefined && aiProviderId === undefined) {
    if (aiProviderExclusive) {
      const [current] = await db.select({ aiProviderId: projects.aiProviderId }).from(projects).where(eq(projects.id, projectId));
      updates.aiProviderExclusive = current?.aiProviderId != null;
    } else {
      updates.aiProviderExclusive = false;
    }
  } else if (aiProviderExclusive !== undefined && aiProviderId !== null) {
    updates.aiProviderExclusive = aiProviderExclusive;
  }

  try {
    return await db.transaction(async (tx): Promise<PatchProjectResult> => {
      // NO KEY UPDATE: mette in fila i salvataggi senza fermare chi inserisce righe che referenziano il progetto.
      const [current] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("no key update");
      if (!current) return { ok: false, error: "not_found" };
      // K-2, la regola del prototipo: il pulse propone dal backlog, quindi
      // acceso senza la discovery è rifiutato; spegnere la discovery lo
      // spegne nello stesso salvataggio.
      const backlogAfter = updates.backlogEnabled ?? current.backlogEnabled;
      if (pulseEnabled === true && !backlogAfter) return { ok: false, error: "pulse_needs_backlog" };
      if (updates.backlogEnabled === false && current.pulseEnabled) updates.pulseEnabled = false;
      // Drizzle rifiuta un update senza colonne: un PATCH vuoto è una lettura.
      if (Object.keys(updates).length === 0) return { ok: true, row: current };
      const [updated] = await tx.update(projects).set(updates).where(eq(projects.id, current.id)).returning();
      await recordProjectChanges(tx, actor, current, updated!);
      return { ok: true, row: updated! };
    });
  } catch (error) {
    if (code !== undefined && isUniqueViolation(error)) return { ok: false, error: "code_taken" };
    throw error;
  }
}
