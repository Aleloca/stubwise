import { inboxActionErrorSchema } from "@stubwise/shared";
import type { HandledBy } from "@stubwise/shared";

/**
 * Errore HTTP dell'API di Stubwise: status + messaggio estratto dal body.
 *
 * `code` è l'identificatore stabile (snake_case, indipendente dalla lingua) che
 * il server invia su `{ code, message }`: le UI lo usano per tradurre. Assente
 * su risposte non-JSON e sugli errori di validazione Zod del server. Status 0 =
 * errore di RETE (il server non ha risposto affatto).
 *
 * Vive qui e non in `apps/web` perché è il tipo d'errore di TUTTI i client
 * dell'API (SPA e app mobile): un `instanceof ApiError` deve valere lo stesso
 * ovunque, e due copie della classe non lo garantirebbero.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /**
   * Body JSON grezzo della risposta d'errore, quando ce n'è uno.
   *
   * `code` e `message` bastano quasi sempre; alcuni errori però portano un DATO
   * che al client serve (oggi il 409 `already_handled`, che dice CHI ha gestito
   * la notifica). Invece di un campo tipizzato per ciascun caso si conserva il
   * body così com'è, `unknown`: chi lo vuole lo valida con lo schema condiviso
   * della sua superficie — vedi {@link handledByFromError}. Assente su risposte
   * non-JSON e di rete.
   */
  readonly details?: unknown;

  constructor(
    status: number,
    message: string,
    code?: string,
    options?: ErrorOptions & { details?: unknown },
  ) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options?.details;
  }
}

/**
 * Costruisce l'{@link ApiError} di una risposta non-ok leggendone il body.
 *
 * Il server risponde `{ code, message }` sugli errori user-facing (`code`
 * assente sugli errori di validazione Zod); il fallback copre le risposte
 * non-JSON (proxy, gateway, artefatti serviti in streaming, …). Caso raro e
 * senza code: message in inglese, coerente con "API in inglese, UI traduce per
 * code".
 */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  const fallback = `Error ${response.status}`;
  const { message, code, details } = await response
    .json()
    .then((data: unknown) => {
      const obj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
      return {
        message: "message" in obj ? String(obj.message) : fallback,
        code: typeof obj.code === "string" ? obj.code : undefined,
        // Il body intero resta a disposizione dei pochi errori che portano un
        // dato oltre a code/message (vedi ApiError.details).
        details: data,
      };
    })
    .catch(() => ({ message: fallback, code: undefined, details: undefined }));
  return new ApiError(response.status, message, code, { details });
}

/**
 * Chi ha già gestito la notifica, letto dal 409 `already_handled`.
 *
 * È l'unico errore dell'API che porta un DATO oltre a `code`/`message`: il body
 * grezzo viaggia in {@link ApiError.details} e qui si valida con lo schema
 * condiviso prima di usarlo — non ci si fida della forma di un body d'errore.
 * Ritorna `undefined` per qualunque altro errore, o se il server non ha saputo
 * dire chi (`handledBy` è opzionale nel contratto).
 */
export function handledByFromError(error: unknown): HandledBy | undefined {
  if (!(error instanceof ApiError) || error.code !== "already_handled") return undefined;
  const parsed = inboxActionErrorSchema.safeParse(error.details);
  return parsed.success ? parsed.data.handledBy : undefined;
}
