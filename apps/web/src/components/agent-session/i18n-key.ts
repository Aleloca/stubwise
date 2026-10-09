import { isUnknown } from "@stubwise/shared";

/**
 * Chiave del catalogo `agents` per un valore di enum aperto da `readerSchema`:
 * il segnaposto `__unknown__` (o un valore che il client non conosce) ha la
 * sua voce `unknown`.
 */
export function catalogKey(value: string): string {
  return isUnknown(value) ? "unknown" : value;
}
