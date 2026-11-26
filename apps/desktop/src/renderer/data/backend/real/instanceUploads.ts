import { ApiError } from "@stubwise/api-client";
import { storageUploadsSchema } from "@stubwise/shared";
import type * as Fake from "../../api";
import { appClient } from "./client";

// Registro, «I blocchi dell'istanza fuori dalla pausa» (72, 344fff90a): il
// Drive e gli allegati dei composer chiedono se un caricamento passerebbe
// adesso. `GET /api/storage/uploads` risponde `{ allowed }` a chiunque sia
// autenticato (storage configurato e valido, la regola di
// `attachmentsEnabled`), senza nessun dato della configurazione.

/** «Si possono caricare file adesso»; un server di prima, senza la rotta (404), non blocca niente. */
export const getUploadsAllowed: (typeof Fake.instance)["getUploadsAllowed"] = async () => {
  try {
    const r = await appClient().request(
      "GET",
      "/api/storage/uploads",
      undefined,
      storageUploadsSchema,
    );
    return r.allowed;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return true;
    throw error;
  }
};

/**
 * Nella build app i blocchi si rileggono alla lettura dopo (nessun evento
 * dal server quando cambiano budget, pausa o storage): ascoltare non avvisa
 * mai, e smettere non fa niente.
 */
export const onInstanceChange: typeof Fake.onInstanceChange = () => () => {};
