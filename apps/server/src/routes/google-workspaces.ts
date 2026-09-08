import { encrypt, googleAccounts, googleWorkspaces } from "@stubwise/db";
import {
  GOOGLE_OAUTH_CALLBACK_PATH,
  googleWorkspaceDraftSchema,
  googleWorkspacePatchSchema,
  googleWorkspaceSchema,
} from "@stubwise/shared";
import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * REGISTRO DEI GOOGLE WORKSPACE (Fase 6, solo admin).
 *
 * Un Workspace è l'app OAuth **interna** che una organizzazione crea nella
 * propria Google Cloud Console: `client_id` + `client_secret`, e l'elenco dei
 * domini email che quell'app può servire. Le caselle degli operatori (Task 5)
 * si collegano SEMPRE attraverso un Workspace, e il callback rifiuta un'email
 * il cui dominio non è in questa lista (`domain_mismatch`).
 *
 * ⚠️ Due invarianti, entrambe presidiate dai test accanto:
 *
 * 1. **Il `client_secret` non esce mai dall'API.** La proiezione pubblica è
 *    costruita campo per campo (mai uno spread della riga) e porta solo il
 *    booleano `clientSecretSet`.
 * 2. **Semantica write-only in scrittura**, identica a quella dei segreti
 *    Slack/S3 d'istanza (`settings.ts`): campo **assente** = il segreto salvato
 *    resta intatto; campo **`""`** = azzeramento esplicito; valore non vuoto =
 *    ricifratura.
 *
 * Nota sull'azzeramento: `google_workspaces.client_secret_encrypted` è NOT NULL
 * (un Workspace nasce sempre con la credenziale), quindi il "nessun segreto" è
 * rappresentato dalla **stringa vuota** — che non è un payload cifrato valido
 * (`encrypt` produce sempre `iv.authTag.ciphertext`) e non può quindi essere
 * confusa con un segreto vero. Chi legge il segreto (il flusso OAuth del Task
 * 5) deve trattare `""` come "credenziale mancante", non passarlo a `decrypt`.
 */

const idParamsSchema = z.object({ id: z.uuid() });

/** Sentinella di "nessun segreto": vedi il docblock in testa al file. */
const NO_SECRET = "";

type GoogleWorkspaceRow = typeof googleWorkspaces.$inferSelect;

function toPublicWorkspace(
  row: GoogleWorkspaceRow,
  accountCount: number,
  redirectUri: string,
): z.infer<typeof googleWorkspaceSchema> {
  return {
    id: row.id,
    name: row.name,
    domains: row.domains,
    clientId: row.clientId,
    clientSecretSet: row.clientSecretEncrypted !== NO_SECRET,
    accountCount,
    redirectUri,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Quante caselle sono collegate a ciascun Workspace (per la UI e per il 409). */
async function countAccountsByWorkspace(
  db: FastifyInstance["db"],
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      workspaceId: googleAccounts.workspaceId,
      count: sql<number>`count(*)::int`,
    })
    .from(googleAccounts)
    .groupBy(googleAccounts.workspaceId);
  return new Map(rows.map((row) => [row.workspaceId, row.count]));
}

async function countAccounts(db: FastifyInstance["db"], workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(googleAccounts)
    .where(eq(googleAccounts.workspaceId, workspaceId));
  return row?.count ?? 0;
}

export async function googleWorkspaceRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // L'URL di redirect è UNO per istanza (non per Workspace): lo compone il
  // server perché è l'unico a conoscere l'URL pubblico effettivo, ed è la
  // stringa che l'admin deve incollare pari pari nella Google Cloud Console.
  const redirectUri = () => `${app.publicUrl}${GOOGLE_OAUTH_CALLBACK_PATH}`;

  app.get(
    "/",
    {
      preHandler: requireAdmin,
      schema: { response: { 200: z.array(googleWorkspaceSchema), ...authErrorResponses } },
    },
    async () => {
      const [rows, counts] = await Promise.all([
        app.db.select().from(googleWorkspaces).orderBy(asc(googleWorkspaces.createdAt)),
        countAccountsByWorkspace(app.db),
      ]);
      const uri = redirectUri();
      return rows.map((row) => toPublicWorkspace(row, counts.get(row.id) ?? 0, uri));
    },
  );

  app.post(
    "/",
    {
      preHandler: requireAdmin,
      schema: {
        body: googleWorkspaceDraftSchema,
        response: { 201: googleWorkspaceSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { name, domains, clientId, clientSecret } = request.body;
      const [created] = await app.db
        .insert(googleWorkspaces)
        .values({
          name,
          domains,
          clientId,
          clientSecretEncrypted: encrypt(clientSecret, app.encryptionKey),
        })
        .returning();
      if (!created) throw new Error("insert del Workspace non ha restituito la riga");
      return reply.code(201).send(toPublicWorkspace(created, 0, redirectUri()));
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        body: googleWorkspacePatchSchema,
        response: {
          200: googleWorkspaceSchema,
          400: errorSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { name, domains, clientId, clientSecret } = request.body;
      const updates: Partial<GoogleWorkspaceRow> = {};
      if (name !== undefined) updates.name = name;
      if (domains !== undefined) updates.domains = domains;
      if (clientId !== undefined) updates.clientId = clientId;
      // Qui vive la semantica write-only: `undefined` (campo assente nel body)
      // non entra in `updates` e il segreto salvato resta intatto; `""` scrive
      // la sentinella di azzeramento; qualunque altro valore viene ricifrato.
      if (clientSecret !== undefined) {
        updates.clientSecretEncrypted =
          clientSecret === "" ? NO_SECRET : encrypt(clientSecret, app.encryptionKey);
      }

      // Drizzle rifiuta un update senza colonne: una patch vuota è una lettura.
      const [row] =
        Object.keys(updates).length === 0
          ? await app.db
              .select()
              .from(googleWorkspaces)
              .where(eq(googleWorkspaces.id, request.params.id))
          : await app.db
              .update(googleWorkspaces)
              .set(updates)
              .where(eq(googleWorkspaces.id, request.params.id))
              .returning();
      if (!row) {
        return apiError(reply, 404, "google_workspace_not_found", "Google Workspace not found");
      }
      return toPublicWorkspace(row, await countAccounts(app.db, row.id), redirectUri());
    },
  );

  app.delete(
    "/:id",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: {
          204: z.null(),
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select({ id: googleWorkspaces.id })
        .from(googleWorkspaces)
        .where(eq(googleWorkspaces.id, request.params.id));
      if (!row) {
        return apiError(reply, 404, "google_workspace_not_found", "Google Workspace not found");
      }

      // La FK di `google_accounts.workspace_id` è RESTRICT e basterebbe a
      // impedire la cancellazione, ma darebbe un 500 opaco: il controllo
      // esplicito serve a dire all'admin PERCHÉ non si può (ci sono caselle
      // collegate, che vanno scollegate dai loro proprietari).
      if ((await countAccounts(app.db, row.id)) > 0) {
        return apiError(
          reply,
          409,
          "workspace_in_use",
          "Google Workspace still has connected mailboxes",
        );
      }

      await app.db.delete(googleWorkspaces).where(eq(googleWorkspaces.id, row.id));
      return reply.code(204).send(null);
    },
  );
}
