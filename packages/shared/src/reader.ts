import { z } from "zod";

/**
 * ENUM APERTI LATO LETTORE — perché questo file esiste.
 *
 * Il server valida ciò che EMETTE con lo stesso schema che il client usa per
 * leggere. Va benissimo finché i due capi si aggiornano insieme: la SPA la
 * ridistribuiamo a ogni deploy. **L'app mobile no.** Il rollout passa dagli
 * store e dalla volontà dell'utente di premere "aggiorna", e nel frattempo un
 * server nuovo parla a client vecchi per settimane.
 *
 * Il programma aggiunge un `notification_kind` quasi a ogni fase. Con gli enum
 * chiusi, il primo `project.pulse` di turno farebbe fallire il parse dell'INTERA
 * lista d'inbox su ogni telefono già installato — non una card rotta, la
 * schermata principale vuota, e senza rebuild che ci salvi.
 *
 * Da qui la derivazione: {@link readerSchema} prende uno schema RIGIDO e ne
 * ricava la variante "da lettore", in cui ogni valore d'enum sconosciuto
 * diventa {@link UNKNOWN} invece di far esplodere tutto. Il server continua a
 * usare l'originale, rigido — se emette un valore che non conosce è un bug e
 * deve esplodere subito.
 *
 * DERIVATA e non scritta a mano: gli enum raggiungibili dalle risposte sono
 * ventidue, e una variante gemella per schema sposterebbe il "posso
 * dimenticarmene" da un enum a ogni schema nuovo. Qui non c'è niente da
 * ricordare — e che non ci sia è verificato da un test, non promesso da un
 * commento (vedi `reader.test.ts` qui accanto e `reader.test.ts` in
 * `@stubwise/api-client`).
 */

/**
 * Il valore che prende il posto di un enum che questo client non conosce.
 *
 * Deve essere impossibile da confondere con un valore vero: se un giorno un
 * enum contenesse davvero questa stringa, il fallback diventerebbe
 * indistinguibile da un dato legittimo e la UI direbbe "aggiorna l'app" sopra
 * una card validissima. Un test in `reader.test.ts` sorveglia TUTTI gli enum
 * esportati dal pacchetto perché resti impossibile.
 */
export const UNKNOWN = "__unknown__";
export type Unknown = typeof UNKNOWN;

/** Vero se il valore è il segnaposto di un enum non riconosciuto. */
export function isUnknown(value: unknown): value is Unknown {
  return value === UNKNOWN;
}

/**
 * Il tipo di output di uno schema "da lettore": ogni unione di stringhe
 * letterali ammette in più {@link UNKNOWN}, ricorsivamente.
 *
 * Serve a rendere l'apertura VISIBILE al compilatore: senza, il tipo direbbe
 * `kind: NotificationKind` mentre a runtime può arrivare il segnaposto — un
 * tipo che mente, e uno `switch` senza ramo di default che nessuno segnala.
 * Con, il compilatore OBBLIGA a gestire il caso.
 *
 * `string` nudo non viene toccato (solo le unioni di letterali), e così
 * `unknown`, `null` e i tipi primitivi non stringa.
 */
export type Reader<T> = T extends string
  ? string extends T
    ? T
    : T | Unknown
  : T extends readonly (infer U)[]
    ? Reader<U>[]
    : T extends object
      ? { [K in keyof T]: Reader<T[K]> }
      : T;

/**
 * I tipi di nodo Zod che {@link readerSchema} sa attraversare.
 *
 * `object`/`array`/`optional`/`nullable`/`union` sono ricostruiti scendendo nei
 * figli; `enum` e `literal` di stringa sono APERTI; il resto sono foglie che
 * passano invariate. Qualunque altro tipo di nodo (`record`, `tuple`,
 * `discriminatedUnion`, `intersection`, `lazy`, …) passerebbe invariato pure
 * lui — comportamento SICURO, perché equivale a com'era prima — ma gli enum
 * eventualmente contenuti resterebbero chiusi, cioè il problema tornerebbe in
 * silenzio proprio dove nessuno lo cerca.
 *
 * Per questo l'insieme è esportato: i test lo confrontano con i tipi di nodo
 * davvero presenti negli schemi che i client leggono, e l'introduzione di un
 * nodo non gestito diventa un rosso in CI invece di un buco.
 */
export const READER_NODE_KINDS = [
  "object",
  "array",
  "optional",
  "nullable",
  "union",
  "enum",
  "literal",
  "string",
  "number",
  "boolean",
  "unknown",
] as const;

const SUPPORTED = new Set<string>(READER_NODE_KINDS);

/** Enum aperto: i valori noti più il segnaposto, con fallback sul segnaposto. */
function openValues(values: readonly string[]): z.ZodType {
  return z.enum([...values, UNKNOWN]).catch(UNKNOWN) as unknown as z.ZodType;
}

/**
 * Attraversa lo schema una volta sola, ricostruendolo E annotando i tipi di
 * nodo incontrati. Ricostruzione e ispezione condividono lo STESSO cammino di
 * proposito: se fossero due funzioni potrebbero divergere, e il test che
 * sorveglia i tipi di nodo starebbe sorvegliando un cammino diverso da quello
 * che poi apre gli enum davvero.
 */
// `.shape`, `.options` ed `.element` sono tipati sul core (`$ZodType`), non su
// `ZodType`: il cast è meccanico e riguarda solo i tipi, non il valore.
function child(value: unknown): z.ZodType {
  return value as z.ZodType;
}

function derive(schema: z.ZodType, kinds: Set<string>): z.ZodType {
  const kind = schema.def.type;

  if (schema instanceof z.ZodObject) {
    // Un oggetto "loose"/con catchall non sopravviverebbe a `z.object()`, che lo
    // ricostruisce in modalità strip: si annota a parte, così il test lo vede.
    kinds.add(schema.def.catchall === undefined ? "object" : "object(catchall)");
    const shape = Object.fromEntries(
      Object.entries(schema.shape).map(([key, value]) => [key, derive(child(value), kinds)]),
    );
    return z.object(shape);
  }

  kinds.add(kind);

  // Enum e literal si aprono alla stessa condizione: che i valori siano
  // STRINGHE. Un enum numerico o un `z.literal(true)` non hanno un segnaposto
  // sensato, e `Reader<T>` non tocca i tipi non-stringa — i due capi restano
  // d'accordo senza casi speciali.
  if (schema instanceof z.ZodEnum || schema instanceof z.ZodLiteral) {
    const values: unknown[] =
      schema instanceof z.ZodEnum ? [...schema.options] : [...schema.values];
    return values.every((value) => typeof value === "string")
      ? openValues(values as string[])
      : schema;
  }
  if (schema instanceof z.ZodArray) return z.array(derive(child(schema.element), kinds));
  if (schema instanceof z.ZodOptional) return derive(child(schema.unwrap()), kinds).optional();
  if (schema instanceof z.ZodNullable) return derive(child(schema.unwrap()), kinds).nullable();
  if (schema instanceof z.ZodUnion) {
    const options = schema.options.map((option) => derive(child(option), kinds));
    return z.union(options as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }

  // Foglia (string/number/boolean/unknown) o nodo non gestito: invariata.
  return schema;
}

/** I tipi di nodo Zod raggiungibili dallo schema, sul cammino di `readerSchema`. */
export function readerNodeKinds(schema: z.ZodType): Set<string> {
  const kinds = new Set<string>();
  derive(schema, kinds);
  return kinds;
}

/** I tipi di nodo dello schema che `readerSchema` NON sa attraversare. */
export function unsupportedNodeKinds(schema: z.ZodType): string[] {
  return [...readerNodeKinds(schema)].filter((kind) => !SUPPORTED.has(kind)).sort();
}

// La derivazione è pura e gli schemi sono costanti di modulo: memoizzarla evita
// di ricostruire l'albero a ogni risposta letta.
const cache = new WeakMap<z.ZodType, z.ZodType>();

/**
 * La variante "da lettore" di uno schema di risposta: identica all'originale,
 * salvo che ogni enum accetta anche valori che non conosce e li riporta come
 * {@link UNKNOWN}.
 *
 * ⚠️ `.catch()` sull'enum inghiotte QUALUNQUE fallimento di quel nodo, non solo
 * "stringa fuori elenco": un `123` dove lo schema dice enum diventa
 * {@link UNKNOWN} invece di essere un errore. È accettabile per una ragione
 * precisa, non per distrazione — il server fa passare ogni risposta dal
 * `serializerCompiler` di `fastify-type-provider-zod`, che la valida con lo
 * schema rigido e LANCIA se non combacia. Il caso che `.catch()` maschererebbe
 * non è quindi raggiungibile finché quella validazione lato server esiste.
 * **Chi pensasse di toglierla sappia che a quel punto non perde solo la
 * rigidità del server: perde anche l'unica ragione per cui questo `.catch()` è
 * sicuro.**
 */
export function readerSchema<S extends z.ZodType>(schema: S): z.ZodType<Reader<z.output<S>>> {
  const cached = cache.get(schema);
  if (cached) return cached as z.ZodType<Reader<z.output<S>>>;
  // Il cast è l'unico punto in cui ci si fida di sé: TypeScript non può provare
  // che la ricostruzione produca `Reader<output>`. Lo provano i test, che
  // confrontano tipo e comportamento sullo stesso schema.
  const derived = derive(schema, new Set()) as z.ZodType<Reader<z.output<S>>>;
  cache.set(schema, derived as unknown as z.ZodType);
  return derived;
}
