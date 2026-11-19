import { aiProviders, projects, type Db } from "@stubwise/db";
import { inArray } from "drizzle-orm";
import { recordChange, type ChangeInput } from "./change-log.js";

type ChangeActor = ChangeInput["actor"];

/**
 * Area 9, F5: le voci delle scritture del progetto, coi valori stabili del
 * prototipo (`changelog/settingValues.ts`): gli interruttori `on`/`off`, i
 * numeri in stringa, l'account AI `auto` / `account:<id>[:exclusive]` coi
 * nomi di allora in `params`. Un campo che non cambia non scrive.
 */

type ProjectRow = typeof projects.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const sw = (on: boolean) => (on ? "on" : "off");
const aiAccount = (id: string | null, exclusive: boolean) => (id === null ? "auto" : `account:${id}${exclusive ? ":exclusive" : ""}`);

/** Le colonne degli interruttori e il nome che il prototipo dà loro (`PROJECT_SWITCHES`). */
const SWITCHES = [
  ["docAutoUpdate", "docsNightly"],
  ["dailyReportEnabled", "dailyReport"],
  ["backlogEnabled", "backlogDiscovery"],
  ["pulseEnabled", "pulse"],
  ["weeklyBriefEnabled", "weeklyBrief"],
] as const satisfies readonly (readonly [keyof ProjectRow, string])[];

export const projectObject = (p: Pick<ProjectRow, "id" | "code">) => ({ type: "project", id: p.id, label: p.code });

export async function recordProjectChanges(tx: Tx, actor: ChangeActor, before: ProjectRow, after: ProjectRow): Promise<void> {
  const base = { actor, projectId: after.id };
  const object = projectObject(after);
  if (before.name !== after.name) {
    await recordChange(tx, { ...base, type: "project.renamed", data: { object, before: before.name, after: after.name } });
  }
  // La descrizione è testo libero: la voce dice che è cambiata, non cosa dice.
  if ((before.description ?? "") !== (after.description ?? "")) {
    await recordChange(tx, { ...base, type: "project.description_changed", data: { object } });
  }
  const docsBefore = before.modules.includes("docs");
  const docsAfter = after.modules.includes("docs");
  if (docsBefore !== docsAfter) {
    await recordChange(tx, { ...base, type: "project.docs_toggled", data: { object, before: sw(docsBefore), after: sw(docsAfter) } });
  }
  const accountBefore = aiAccount(before.aiProviderId, before.aiProviderExclusive);
  const accountAfter = aiAccount(after.aiProviderId, after.aiProviderExclusive);
  if (accountBefore !== accountAfter) {
    const ids = [before.aiProviderId, after.aiProviderId].filter((id): id is string => id !== null);
    const names = new Map(
      ids.length > 0 ? (await tx.select({ id: aiProviders.id, label: aiProviders.label }).from(aiProviders).where(inArray(aiProviders.id, ids))).map((p) => [p.id, p.label]) : [],
    );
    const params: Record<string, string> = {};
    if (before.aiProviderId && names.has(before.aiProviderId)) params.accountBefore = names.get(before.aiProviderId)!;
    if (after.aiProviderId && names.has(after.aiProviderId)) params.accountAfter = names.get(after.aiProviderId)!;
    await recordChange(tx, { ...base, type: "project.ai_account_changed", data: { object, before: accountBefore, after: accountAfter, params } });
  }
  for (const [column, name] of SWITCHES) {
    if (before[column] !== after[column]) {
      await recordChange(tx, { ...base, type: "project.switch_changed", data: { object, before: sw(before[column]), after: sw(after[column]), params: { switch: name } } });
    }
  }
  if (before.pulseEveryDays !== after.pulseEveryDays) {
    await recordChange(tx, { ...base, type: "project.pulse_interval_changed", data: { object, before: String(before.pulseEveryDays), after: String(after.pulseEveryDays) } });
  }
  if (before.prCorrectionMaxRounds !== after.prCorrectionMaxRounds) {
    await recordChange(tx, { ...base, type: "project.correction_cap_changed", data: { object, before: String(before.prCorrectionMaxRounds), after: String(after.prCorrectionMaxRounds) } });
  }
}
