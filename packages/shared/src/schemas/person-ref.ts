import { z } from "zod";

/**
 * Registro, A11 r.1414: l'id di una persona in una RISPOSTA, oppure il
 * segnaposto `hidden-<n>` per chi chi guarda non conosce (stabile nella
 * risposta, mai da mandare indietro: le scritture vogliono un uuid). Una foglia:
 * la usano più schemi (Chat, doc di prodotto, …).
 */
export const personRefSchema = z.string().min(1);
