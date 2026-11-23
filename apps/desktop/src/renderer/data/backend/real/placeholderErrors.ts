import { ApiError } from "@stubwise/api-client";

// Registro, A11 r.1414 (72, 188ecb996): un segnaposto `hidden-<n>` dove il
// server vuole una persona è 400 `invalid`, col campo in testa al messaggio
// («criteria: a placeholder is not a person id», «addedById: …»): non c'è
// un campo `field` a parte. Il prototipo dice lo stesso rifiuto come
// `invalid: <campo>`.

const FIELD = /^([A-Za-z][A-Za-z.]*):/;

/** Un 400 `invalid` col campo nel messaggio diventa `invalid: <campo>`; il resto resta com'è. */
export function placeholderError(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.status !== 400 || error.code !== "invalid")
    return error;
  const field = FIELD.exec(error.message)?.[1];
  return field ? new Error(`invalid: ${field}`) : error;
}

/** Una chiamata il cui 400 per un segnaposto si dice nelle parole del prototipo. */
export async function withPlaceholderErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw placeholderError(error);
  }
}
