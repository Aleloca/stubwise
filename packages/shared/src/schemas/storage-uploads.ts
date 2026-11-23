import { z } from "zod";

/**
 * `GET /api/storage/uploads` (registro, r.1121, i blocchi dell'istanza): un
 * caricamento passerebbe adesso? Lo leggono i composer della Chat e delle
 * conversazioni con Claude, per chiunque sia autenticato; nessun dato della
 * configurazione. `allowed` = lo storage è configurato e valido (la regola di
 * `storageAllowsUploads` del prototipo; l'esito della prova di connessione il
 * server non lo tiene). `.default(true)`: un server di prima non blocca i
 * composer, e il caricamento resta l'arbitro.
 */
export const storageUploadsSchema = z.object({
  allowed: z.boolean().default(true),
});
export type StorageUploads = z.infer<typeof storageUploadsSchema>;
