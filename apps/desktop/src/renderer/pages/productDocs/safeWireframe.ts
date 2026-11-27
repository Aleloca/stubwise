import { sanitizeWireframeSvg } from "@stubwise/shared";

/**
 * Lo SVG di una bozza di schermata, ripulito PRIMA di entrare nel documento
 * (`dangerouslySetInnerHTML`). Il server lo ripulisce già prima di salvarlo
 * (`sanitizeWireframeSvg`, la stessa allowlist chiusa); qui lo si rifà per
 * difesa in profondità: un server di prima, una riga scritta a mano, il seme.
 * Uno SVG che non regge diventa `null`: lo schizzo si legge «gone».
 */
export const safeWireframeSvg = (svg: string | null | undefined): string | null =>
  svg == null ? null : sanitizeWireframeSvg(svg);
