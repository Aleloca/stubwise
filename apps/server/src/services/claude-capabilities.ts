import { googleAccounts, type Db } from "@stubwise/db";
import { GMAIL_MODIFY_SCOPE } from "@stubwise/google";
import { CLAUDE_CAPABILITY_IDS, type ClaudeCapabilityId, type ProjectPermission } from "@stubwise/shared";
import { and, isNull, sql, eq } from "drizzle-orm";
import { isAllProjects, projectIdsWithPermission } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { SERVER_CATALOG } from "../claude-actions/catalog.js";
import { usageScope } from "./usage-summary.js";

/**
 * Area 10, F7 (S0, D-1 = a, F7-1 = a): ciò che Claude sa fare per CHI CHIEDE,
 * dalle sue firme vere (mai dal ruolo): una capacità c'è solo se la sua azione
 * passerebbe in almeno un posto. La regola sta QUI, sulle `access` delle voci
 * di `SERVER_CATALOG` quando ce l'hanno:
 * - `automation`: `automations.manage` in un progetto (la regola di
 *   `createAutomation`, che la voce controlla nel servizio);
 * - `stalled`: sempre (Claude legge ciò che la persona vede);
 * - `spend`: la regola di `/api/ai-usage/summary` (`usageScope`);
 * - `archive`: il permesso della voce `archiveProject`;
 * - `addMember`: il permesso della voce `addMember`;
 * - `releaseNotes`: `release.merge` o `tickets.edit` (la regola di
 *   `putPrReleaseNotes`, F6-1 = a);
 * - `mailBody`: una casella Google di chi chiede, viva e con gmail.modify
 *   (la regola di `fillMailBody`);
 * - `taskDescription`: il permesso della voce `updateTask`;
 * - area 11, F6: `productFirstVersion`, `productUpdate`, `productWireframe`
 *   coi permessi delle loro voci (`docs.edit`), `productBacklog` con quello di
 *   `createRequest`, `productChanges` con `docs.view` (la regola di
 *   `/api/product-changes`).
 * Solo id, nell'ordine del prototipo: nessun dato di un progetto.
 */
export async function claudeCapabilitiesOf(db: Db, user: Pick<SessionUser, "id" | "instancePermissions">): Promise<ClaudeCapabilityId[]> {
  const anywhere = async (permission: ProjectPermission) => {
    const scope = await projectIdsWithPermission(db, user, permission);
    return isAllProjects(scope) || scope.length > 0;
  };
  const permissionOf = (fn: "archiveProject" | "addMember" | "updateTask" | "writeFirstVersion" | "updateProductPage" | "drawWireframe" | "createRequest"): ProjectPermission => {
    const access = SERVER_CATALOG.get(fn)!.access;
    if (access.kind !== "project" || access.permission === "member") throw new Error(`${fn}: un permesso di progetto atteso`);
    return access.permission;
  };
  const spend = await usageScope(db, user);
  const [mailbox] = await db
    .select({ id: googleAccounts.id })
    .from(googleAccounts)
    .where(and(eq(googleAccounts.userId, user.id), isNull(googleAccounts.disabledAt), sql`${GMAIL_MODIFY_SCOPE} = any(${googleAccounts.scopes})`))
    .limit(1);
  const has: Record<ClaudeCapabilityId, boolean> = {
    automation: await anywhere("automations.manage"),
    stalled: true,
    spend: isAllProjects(spend) || spend.length > 0,
    archive: await anywhere(permissionOf("archiveProject")),
    addMember: await anywhere(permissionOf("addMember")),
    releaseNotes: (await anywhere("release.merge")) || (await anywhere("tickets.edit")),
    mailBody: mailbox !== undefined,
    taskDescription: await anywhere(permissionOf("updateTask")),
    // Area 11, F6, Task 4: le capacità della doc di prodotto, dai permessi delle loro voci.
    productFirstVersion: await anywhere(permissionOf("writeFirstVersion")),
    productUpdate: await anywhere(permissionOf("updateProductPage")),
    productBacklog: await anywhere(permissionOf("createRequest")),
    productWireframe: await anywhere(permissionOf("drawWireframe")),
    // Legge i cambi (`read_product_changes`): chi legge i Docs in un progetto.
    productChanges: await anywhere("docs.view"),
  };
  return CLAUDE_CAPABILITY_IDS.filter((id) => has[id]);
}
