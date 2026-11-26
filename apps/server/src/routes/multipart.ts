/**
 * Un multipart oltre i limiti di parti, file o campi (`@fastify/multipart`,
 * 413 di suo): le rotte che vogliono UN file e nient'altro lo rendono 400
 * `invalid_multipart` (review della fetta 2 dell'area 5).
 */
export function isMultipartLimit(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "FST_PARTS_LIMIT" || code === "FST_FILES_LIMIT" || code === "FST_FIELDS_LIMIT";
}
