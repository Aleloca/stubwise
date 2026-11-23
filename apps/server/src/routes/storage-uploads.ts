import { instanceSettings } from "@stubwise/db";
import { storageUploadsSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { storageConfigured } from "./settings.js";
import { authErrorResponses } from "./shared.js";

/**
 * `GET /api/storage/uploads` (registro, r.1121, i blocchi dell'istanza): un
 * caricamento passerebbe adesso? Per i composer della Chat e delle
 * conversazioni con Claude, che non hanno `settings.manage`. Solo un booleano,
 * nessun dato della configurazione.
 */
export async function storageUploadsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/uploads",
    { config: { access: { kind: "user" } }, schema: { response: { 200: storageUploadsSchema, ...authErrorResponses } } },
    async () => {
      const [row] = await app.db.select().from(instanceSettings).limit(1);
      return { allowed: storageConfigured(row, app.encryptionKey) };
    },
  );
}
