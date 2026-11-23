import { z } from "zod";

/**
 * Registro, A11 r.1414: l'id di una persona in una RISPOSTA, oppure il
 * segnaposto `hidden-<n>` per chi chi guarda non conosce (stabile nella
 * risposta, mai da mandare indietro: le scritture vogliono un uuid). Una foglia:
 * la usano più schemi (Chat, doc di prodotto, …).
 */
export const personRefSchema = z.string().min(1);

/** Il segnaposto di una persona sconosciuta (`hidden-<n>`). */
export const personPlaceholderSchema = z.string().regex(/^hidden-\d{1,6}$/);
export const isPersonPlaceholder = (v: unknown): v is string => typeof v === "string" && /^hidden-\d{1,6}$/.test(v);
