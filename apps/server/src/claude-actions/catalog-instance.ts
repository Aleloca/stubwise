import { aiModelSettings, aiProviders, gitAccounts, googleWorkspaces, instanceSettings, outgoingWebhooks, type Db } from "@stubwise/db";
import type { AiModelChoice, AiOperation, UpdateOutgoingWebhookInput } from "@stubwise/shared";
import { asc, eq, sql } from "drizzle-orm";
import { LAST_ENABLED, patchProvider, reorderProviders } from "../routes/ai-providers.js";
import { patchGitAccount } from "../routes/git-accounts.js";
import { patchGoogleWorkspace } from "../routes/google-workspaces.js";
import { patchModelSettings } from "../routes/model-settings.js";
import { putAutomationSettings, putInstanceSettings, readAutomationSettings } from "../routes/settings.js";
import { updateWebhook } from "../services/outgoing-webhooks.js";
import { deletePlugin, requestSmoke } from "../services/plugins.js";
import { RoleRuleError } from "../services/roles.js";
import type { ActionObject, CatalogEntry, CatalogRefusal } from "./catalog.js";

/**
 * Area 9, F7, Task 4: le voci d'istanza (il prototipo, `data/claude/catalog.ts`,
 * «istanza, senza segreti»). Ognuna chiama la funzione della sua rotta, con la
 * chiave di cifratura a null: gli argomenti non portano mai un segreto (M-4 =
 * a, schemi `strict` in `@stubwise/shared`), quindi la riconferma PARZIALE di
 * quelle rotte non scatta mai da qui. L'accesso è il permesso d'istanza della
 * rotta (il test d'accordo lo confronta).
 *
 * Fuori, per ora (ruling, `integrazione-registro-rimandi.md`): `saveStorage`
 * (review di F7: endpoint e bucket decidono dove vanno gli allegati, come
 * l'url di un webhook, e la chiave d'accesso non si legge da qui), `setAttachments`
 * (sul server gli allegati non hanno un interruttore: si accendono con
 * l'archiviazione configurata) e `setDefaultReviewer` (il PUT verifica il token
 * chiamando il provider: lo farebbe a ogni prova a secco, dentro la
 * transazione).
 */

const refused = (code: CatalogRefusal["code"], message: string) => ({ ok: false as const, refusal: { code, message } });

/** L'istante della scrittura, ai microsecondi (come `catalog-area9.ts`). */
async function txNow(tx: Db): Promise<string> {
  const res = (await tx.execute(sql`select now()::text as at`)) as unknown as { rows?: { at: string }[] } & { at: string }[];
  return (res.rows ?? res)[0]!.at;
}

/**
 * L'impostazione come oggetto dell'azione: il soggetto delle sue voci del
 * registro (`subjectKind`, e `id` se è uno solo) e i tipi che contano per
 * `changed_after` (M-7 = a).
 */
const setting = async (tx: Db, subjectKind: string, id: string, changeTypes: readonly string[]): Promise<ActionObject> => ({
  kind: "setting",
  subjectKind,
  id,
  changeTypes,
  stamp: await txNow(tx),
});

const instanceRow = async (tx: Db) => (await tx.select().from(instanceSettings).where(eq(instanceSettings.id, 1)))[0] ?? null;

function webhookRefusal(error: unknown): { ok: false; refusal: CatalogRefusal } {
  if (!(error instanceof RoleRuleError)) throw error;
  return refused(error.status === 404 ? "not_found" : error.status === 403 ? "forbidden" : error.status === 409 ? "conflict" : "invalid", error.code);
}

const done = (inverse: { fn: string; args: Record<string, unknown> } | null, objects: ActionObject[]) =>
  ({ ok: true as const, result: { inverse: inverse as never, objects, codes: [] } });

export const INSTANCE_ENTRIES: CatalogEntry[] = [
  {
    fn: "setModel",
    route: "PATCH /api/settings/models",
    access: { kind: "instance", permission: "settings.manage" },
    request: () => ({}),
    async run(tx, user, args) {
      const { operation, model } = args as { operation: AiOperation; model: AiModelChoice | null };
      const [was] = await tx.select({ model: aiModelSettings.model }).from(aiModelSettings).where(eq(aiModelSettings.operation, operation));
      const out = await patchModelSettings(tx, user, { [operation]: model });
      if (!out.ok) return refused("invalid", "not_configurable");
      return done({ fn: "setModel", args: { operation, model: was?.model ?? null } }, [await setting(tx, "ai_settings", operation, ["model.changed"])]);
    },
  },
  {
    fn: "saveBudget",
    route: "PUT /api/settings/instance",
    access: { kind: "instance", permission: "settings.manage" },
    request: () => ({}),
    async run(tx, user, args) {
      const { monthlyUsd, contentLanguage } = args as { monthlyUsd: number | null; contentLanguage: "en" | "it" };
      const was = await instanceRow(tx);
      await putInstanceSettings(tx, null, user, { monthlyBudgetUsd: monthlyUsd, contentLanguage });
      return done(
        { fn: "saveBudget", args: { monthlyUsd: was?.monthlyBudgetUsd != null ? Number(was.monthlyBudgetUsd) : null, contentLanguage: was?.contentLanguage ?? "en" } },
        [await setting(tx, "ai_settings", "", ["budget.changed", "content_language.changed"])],
      );
    },
  },
  {
    fn: "saveAutomation",
    route: "PUT /api/settings/automation",
    access: { kind: "instance", permission: "settings.manage" },
    request: () => ({}),
    async run(tx, user, args) {
      const was = await readAutomationSettings(tx);
      await putAutomationSettings(tx, user, args as Parameters<typeof putAutomationSettings>[2]);
      return done({ fn: "saveAutomation", args: was }, [await setting(tx, "ai_settings", "automation", ["automation.changed"])]);
    },
  },
  {
    fn: "setProviderEnabled",
    route: "PATCH /api/ai-providers/:id",
    access: { kind: "instance", permission: "ai_providers.manage" },
    request: (args) => ({ params: { id: args["id"] } }),
    async run(tx, user, args) {
      const { id, enabled } = args as { id: string; enabled: boolean };
      const [was] = await tx.select({ enabled: aiProviders.enabled }).from(aiProviders).where(eq(aiProviders.id, id));
      const row = await patchProvider(tx, null, user, id, { enabled });
      if (row === LAST_ENABLED) return refused("conflict", "last_enabled_provider");
      if (!row || !was) return refused("not_found", "ai_provider_not_found");
      return done({ fn: "setProviderEnabled", args: { id, enabled: was.enabled } }, [await setting(tx, "provider", id, ["provider.updated"])]);
    },
  },
  {
    // Sposta un account al posto `toIndex` dell'ordine di failover.
    fn: "moveProvider",
    route: "POST /api/ai-providers/reorder",
    access: { kind: "instance", permission: "ai_providers.manage" },
    request: () => ({}),
    async run(tx, user, args) {
      const { id, toIndex } = args as { id: string; toIndex: number };
      const ids = (await tx.select({ id: aiProviders.id }).from(aiProviders).orderBy(asc(aiProviders.position), asc(aiProviders.createdAt))).map((r) => r.id);
      const from = ids.indexOf(id);
      if (from < 0) return refused("not_found", "ai_provider_not_found");
      if (toIndex >= ids.length) return refused("invalid", "reorder_out_of_range");
      ids.splice(from, 1);
      ids.splice(toIndex, 0, id);
      if ((await reorderProviders(tx, user, ids)) === null) return refused("conflict", "reorder_set_mismatch");
      // Qualunque riordino dopo (il soggetto è il primo account spostato, non per forza questo).
      return done({ fn: "moveProvider", args: { id, toIndex: from } }, [await setting(tx, "provider", "", ["provider.reordered"])]);
    },
  },
  {
    // Nome e workspace, mai le credenziali. Un workspace che prima non c'era
    // non si toglie dalla rotta: quell'«Annulla» non c'è.
    fn: "updateGitAccount",
    route: "PATCH /api/git-accounts/:id",
    access: { kind: "instance", permission: "git_accounts.manage" },
    request: (args) => ({ params: { id: args["id"] } }),
    async run(tx, user, args) {
      const { id, name, workspace } = args as { id: string; name?: string; workspace?: string };
      const [was] = await tx.select({ name: gitAccounts.name, workspace: gitAccounts.workspace }).from(gitAccounts).where(eq(gitAccounts.id, id));
      const row = await patchGitAccount(tx, null, user, id, { name, workspace });
      if (row === "not_found" || !was) return refused("not_found", "git_account_not_found");
      if (row === "workspace_locked") return refused("conflict", "default_reviewer_workspace_locked");
      const undoable = workspace === undefined || was.workspace !== null;
      return done(
        undoable ? { fn: "updateGitAccount", args: { id, ...(name !== undefined ? { name: was.name } : {}), ...(workspace !== undefined ? { workspace: was.workspace } : {}) } } : null,
        [await setting(tx, "git_account", id, ["git_account.updated"])],
      );
    },
  },
  {
    // Nome, domini e client id, mai il secret.
    fn: "updateGoogleApp",
    route: "PATCH /api/settings/google-workspaces/:id",
    access: { kind: "instance", permission: "integrations.manage" },
    request: (args) => ({ params: { id: args["id"] } }),
    async run(tx, user, args) {
      const { id, name, domains, clientId } = args as { id: string; name?: string; domains?: string[]; clientId?: string };
      const [was] = await tx.select().from(googleWorkspaces).where(eq(googleWorkspaces.id, id));
      const row = await patchGoogleWorkspace(tx, null, user, id, { name, domains, clientId });
      if (!row || !was) return refused("not_found", "google_workspace_not_found");
      return done(
        {
          fn: "updateGoogleApp",
          args: {
            id,
            ...(name !== undefined ? { name: was.name } : {}),
            ...(domains !== undefined ? { domains: was.domains } : {}),
            ...(clientId !== undefined ? { clientId: was.clientId } : {}),
          },
        },
        [await setting(tx, "google_app", id, ["google_app.updated"])],
      );
    },
  },
  {
    // Rimette in coda lo smoke run: lavoro che parte, non si annulla (M-8 = a).
    fn: "rerunSmoke",
    route: "POST /api/plugins/:id/smoke",
    access: { kind: "instance", permission: "plugins.manage" },
    request: (args) => ({ params: { id: args["id"] } }),
    async run(tx, user, args) {
      const result = await requestSmoke(tx, args["id"] as string, user);
      if (!result.ok) return refused(result.error === "not_found" ? "not_found" : "conflict", result.error === "not_found" ? "plugin_not_found" : result.error === "not_ready" ? "plugin_not_ready" : "plugin_job_pending");
      return done(null, []);
    },
  },
  {
    // Toglie un plugin dal registro (non se un progetto lo usa): non si annulla.
    fn: "removePlugin",
    route: "DELETE /api/plugins/:id",
    access: { kind: "instance", permission: "plugins.manage" },
    request: (args) => ({ params: { id: args["id"] } }),
    async run(tx, user, args) {
      const result = await deletePlugin(tx, args["id"] as string, user);
      if (!result.ok) return refused(result.error === "not_found" ? "not_found" : "conflict", result.error === "not_found" ? "plugin_not_found" : "plugin_in_use");
      return done(null, []);
    },
  },
  {
    // Nome, formato, interruttore ed eventi: MAI l'url (chiede la riconferma).
    fn: "updateWebhook",
    route: "PATCH /api/settings/webhooks/:id",
    access: { kind: "instance", permission: "integrations.manage" },
    request: (args) => ({ params: { id: args["id"] } }),
    async run(tx, user, args) {
      const { id, ...patch } = args as { id: string } & UpdateOutgoingWebhookInput;
      const [was] = await tx.select().from(outgoingWebhooks).where(eq(outgoingWebhooks.id, id));
      if (!was) return refused("not_found", "webhook_not_found");
      try {
        await updateWebhook(tx, user, id, patch);
      } catch (error) {
        return webhookRefusal(error);
      }
      const back: Record<string, unknown> = { id };
      if (patch.name !== undefined) back["name"] = was.name;
      if (patch.format !== undefined) back["format"] = was.format;
      if (patch.enabled !== undefined) back["enabled"] = was.enabled;
      if (patch.events !== undefined) back["events"] = was.events;
      return done({ fn: "updateWebhook", args: back }, [await setting(tx, "webhook", id, ["webhook.updated"])]);
    },
  },
];
