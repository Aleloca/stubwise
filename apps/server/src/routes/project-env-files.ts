import { encrypt, projectEnvFiles, projectEnvVars, projects } from "@stubwise/db";
import { isSafeRelPath, isValidEnvKey, parseDotenv } from "@stubwise/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin } from "../auth/session.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";
import { apiError } from "../errors.js";

const createFileSchema = z.object({ path: z.string() });
const importSchema = z.object({ content: z.string() });
const putVarSchema = z.object({ value: z.string() });

const projectParamsSchema = z.object({ id: z.uuid() });
const fileParamsSchema = z.object({ id: z.uuid(), fileId: z.uuid() });
const varParamsSchema = z.object({ id: z.uuid(), fileId: z.uuid(), key: z.string() });

/**
 * Proiezione pubblica di una variabile d'ambiente: solo il nome della chiave e
 * il flag `valueSet`. Il valore (cifrato a riposo) è write-only e non esce MAI
 * dall'API: lo decifra unicamente il worker quando materializza il file.
 */
const publicVarSchema = z.object({ key: z.string(), valueSet: z.literal(true) });

/** Proiezione pubblica di un file env: id, path e l'elenco delle sue var. */
const publicFileSchema = z.object({
  id: z.uuid(),
  path: z.string(),
  vars: z.array(publicVarSchema),
});

/** Esito dell'import: quante chiavi valide sono state importate e quali. */
const importResultSchema = z.object({
  count: z.int(),
  imported: z.array(z.string()),
});

/**
 * Route dei file d'ambiente di un progetto, registrate sotto /api/projects.
 * Tutte solo admin. I valori delle variabili sono cifrati AES-256-GCM at rest
 * (vedi secrets.ts) e non escono MAI dall'API: la proiezione pubblica è
 * write-only (espone solo `valueSet`). `path` e `key` sono sempre validati in
 * ingresso (anti-traversal) con isSafeRelPath/isValidEnvKey. Le var sono
 * upsert: PUT crea o sostituisce, l'import fa upsert sulle chiavi valide.
 */
export async function projectEnvFileRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Carica le var del file come proiezione pubblica (key + valueSet), ordinate
  // per key. Mai il valore cifrato.
  async function publicVarsOf(fileId: string): Promise<z.infer<typeof publicVarSchema>[]> {
    const rows = await app.db
      .select({ key: projectEnvVars.key })
      .from(projectEnvVars)
      .where(eq(projectEnvVars.fileId, fileId))
      .orderBy(asc(projectEnvVars.key));
    return rows.map((r) => ({ key: r.key, valueSet: true as const }));
  }

  // Verifica che il file esista E appartenga al progetto dell'URL: evita di
  // operare su file di altri progetti tramite fileId indovinati.
  async function findFile(projectId: string, fileId: string) {
    const [row] = await app.db
      .select()
      .from(projectEnvFiles)
      .where(and(eq(projectEnvFiles.id, fileId), eq(projectEnvFiles.projectId, projectId)));
    return row;
  }

  app.post(
    "/:id/env-files",
    {
      preHandler: requireAdmin,
      schema: {
        params: projectParamsSchema,
        body: createFileSchema,
        response: {
          201: publicFileSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id: projectId } = request.params;
      const { path } = request.body;
      if (!isSafeRelPath(path)) {
        return apiError(reply, 400, "invalid_env_path", "Env file path is not a safe relative path");
      }

      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      try {
        const [created] = await app.db
          .insert(projectEnvFiles)
          .values({ projectId, path })
          .returning();
        if (!created) throw new Error("insert del file env non ha restituito la riga");
        return await reply.code(201).send({ id: created.id, path: created.path, vars: [] });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return apiError(reply, 409, "env_path_conflict", "An env file with this path already exists");
        }
        throw error;
      }
    },
  );

  app.get(
    "/:id/env-files",
    {
      preHandler: requireAdmin,
      schema: {
        params: projectParamsSchema,
        response: { 200: z.array(publicFileSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id: projectId } = request.params;
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      const files = await app.db
        .select()
        .from(projectEnvFiles)
        .where(eq(projectEnvFiles.projectId, projectId))
        .orderBy(asc(projectEnvFiles.path));
      return Promise.all(
        files.map(async (f) => ({ id: f.id, path: f.path, vars: await publicVarsOf(f.id) })),
      );
    },
  );

  // Import dotenv: parsa il contenuto, scarta le chiavi non valide, cifra ogni
  // valore e fa upsert (on conflict (file_id,key) → update value + updated_at).
  // Ritorna SOLO l'elenco delle chiavi importate, MAI i valori.
  app.post(
    "/:id/env-files/:fileId/import",
    {
      preHandler: requireAdmin,
      schema: {
        params: fileParamsSchema,
        body: importSchema,
        response: { 200: importResultSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id: projectId, fileId } = request.params;
      const file = await findFile(projectId, fileId);
      if (!file) return apiError(reply, 404, "env_file_not_found", "Env file not found");

      const valid = parseDotenv(request.body.content).filter((v) => isValidEnvKey(v.key));
      for (const { key, value } of valid) {
        const valueEncrypted = encrypt(value, app.encryptionKey);
        await app.db
          .insert(projectEnvVars)
          .values({ fileId, key, valueEncrypted })
          .onConflictDoUpdate({
            target: [projectEnvVars.fileId, projectEnvVars.key],
            set: { valueEncrypted, updatedAt: sql`now()` },
          });
      }
      const imported = valid.map((v) => v.key);
      return { count: imported.length, imported };
    },
  );

  // Upsert di una singola var: crea se assente, sostituisce (ricifra) se
  // presente. La key del path è sempre validata (400 se non valida). Nessun
  // valore in risposta.
  app.put(
    "/:id/env-files/:fileId/vars/:key",
    {
      preHandler: requireAdmin,
      schema: {
        params: varParamsSchema,
        body: putVarSchema,
        response: { 200: publicVarSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id: projectId, fileId, key } = request.params;
      if (!isValidEnvKey(key)) {
        return apiError(reply, 400, "invalid_env_key", "Env variable key is not valid");
      }
      const file = await findFile(projectId, fileId);
      if (!file) return apiError(reply, 404, "env_file_not_found", "Env file not found");

      const valueEncrypted = encrypt(request.body.value, app.encryptionKey);
      await app.db
        .insert(projectEnvVars)
        .values({ fileId, key, valueEncrypted })
        .onConflictDoUpdate({
          target: [projectEnvVars.fileId, projectEnvVars.key],
          set: { valueEncrypted, updatedAt: sql`now()` },
        });
      return { key, valueSet: true as const };
    },
  );

  app.delete(
    "/:id/env-files/:fileId/vars/:key",
    {
      preHandler: requireAdmin,
      schema: {
        params: varParamsSchema,
        response: { 204: z.null(), 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id: projectId, fileId, key } = request.params;
      if (!isValidEnvKey(key)) {
        return apiError(reply, 400, "invalid_env_key", "Env variable key is not valid");
      }
      const file = await findFile(projectId, fileId);
      if (!file) return apiError(reply, 404, "env_file_not_found", "Env file not found");

      const deleted = await app.db
        .delete(projectEnvVars)
        .where(and(eq(projectEnvVars.fileId, fileId), eq(projectEnvVars.key, key)))
        .returning({ id: projectEnvVars.id });
      if (deleted.length === 0) {
        return apiError(reply, 404, "env_var_not_found", "Env variable not found");
      }
      return reply.code(204).send(null);
    },
  );

  app.delete(
    "/:id/env-files/:fileId",
    {
      preHandler: requireAdmin,
      schema: {
        params: fileParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id: projectId, fileId } = request.params;
      // Il vincolo sul projectId evita di cancellare file di altri progetti.
      const deleted = await app.db
        .delete(projectEnvFiles)
        .where(and(eq(projectEnvFiles.id, fileId), eq(projectEnvFiles.projectId, projectId)))
        .returning({ id: projectEnvFiles.id });
      if (deleted.length === 0) {
        return apiError(reply, 404, "env_file_not_found", "Env file not found");
      }
      // Le var sono cancellate in cascata dal FK (onDelete: cascade).
      return reply.code(204).send(null);
    },
  );
}
