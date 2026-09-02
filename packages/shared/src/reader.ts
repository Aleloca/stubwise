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
 *
 * Fuori dall'elenco — cioè segnalati — finiscono anche alcune FORME dei nodi
 * che pure sappiamo attraversare, perché attraversarle sarebbe INFEDELE:
 * `object(catchall)` (la ricostruzione lo appiattirebbe a strip),
 * `<nodo>(checks)` (un `.refine()`/`.max()` che la ricostruzione perderebbe),
 * `discriminatedUnion` e `union(opened)` (vedi il commento sulle union in
 * `derive`: lì aprire un enum cambierebbe QUALE opzione vince).
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
 * Stato di una singola derivazione: i tipi di nodo incontrati e QUANTI enum
 * sono stati aperti. Il conteggio non è statistica — serve alle union, che
 * devono sapere se sotto di loro è cambiato qualcosa (vedi sotto).
 */
interface Trace {
  kinds: Set<string>;
  opened: number;
}

/**
 * Annota un nodo che stiamo RICOSTRUENDO, segnalando a parte se porta dei
 * `checks`.
 *
 * `.refine()`, `.superRefine()`, `.max()` su un array e simili vivono in
 * `def.checks`, e ricostruire il nodo (`z.object(shape)`, `z.array(inner)`, …)
 * li PERDE: lo schema da lettore accetterebbe ciò che il rigido rifiuta. È un
 * allentamento, quindi nella direzione sicura — ma il guardiano promette
 * "attraversabile fedelmente", e una perdita silenziosa non è fedeltà.
 */
function noteRebuild(schema: z.ZodType, kind: string, trace: Trace): void {
  const checks = (schema.def as { checks?: unknown[] }).checks;
  trace.kinds.add(checks && checks.length > 0 ? `${kind}(checks)` : kind);
}

// `.shape`, `.options` ed `.element` sono tipati sul core (`$ZodType`), non su
// `ZodType`: il cast è meccanico e riguarda solo i tipi, non il valore.
function child(value: unknown): z.ZodType {
  return value as z.ZodType;
}

/**
 * Attraversa lo schema una volta sola, ricostruendolo E annotando i tipi di
 * nodo incontrati. Ricostruzione e ispezione condividono lo STESSO cammino di
 * proposito: se fossero due funzioni potrebbero divergere, e il test che
 * sorveglia i tipi di nodo starebbe sorvegliando un cammino diverso da quello
 * che poi apre gli enum davvero.
 */
function derive(schema: z.ZodType, trace: Trace): z.ZodType {
  if (schema instanceof z.ZodObject) {
    // Un oggetto "loose"/con catchall non sopravviverebbe a `z.object()`, che lo
    // ricostruisce in modalità strip: si annota a parte, così il test lo vede.
    noteRebuild(
      schema,
      schema.def.catchall === undefined ? "object" : "object(catchall)",
      trace,
    );
    const shape = Object.fromEntries(
      Object.entries(schema.shape).map(([key, value]) => [key, derive(child(value), trace)]),
    );
    return z.object(shape);
  }

  // Enum e literal si aprono alla stessa condizione: che i valori siano
  // STRINGHE. Un enum numerico o un `z.literal(true)` non hanno un segnaposto
  // sensato, e `Reader<T>` non tocca i tipi non-stringa — i due capi restano
  // d'accordo senza casi speciali.
  if (schema instanceof z.ZodEnum || schema instanceof z.ZodLiteral) {
    trace.kinds.add(schema.def.type);
    const values: unknown[] =
      schema instanceof z.ZodEnum ? [...schema.options] : [...schema.values];
    if (!values.every((value) => typeof value === "string")) return schema;
    trace.opened += 1;
    return openValues(values as string[]);
  }

  /**
   * ⚠️ LE UNION SONO IL PUNTO DELICATO DI TUTTO IL FILE.
   *
   * `z.union` prova le opzioni IN ORDINE e tiene la prima che passa. Un'opzione
   * aperta però non fallisce MAI — è proprio ciò che `.catch()` le fa fare —
   * quindi vince sempre, e le opzioni successive diventano irraggiungibili. Non
   * è un caso di scuola: `z.union([z.literal("a"), z.literal("b")])` derivato
   * legge `"b"` come UNKNOWN, cioè PERDE un valore legittimo.
   *
   * Peggio con le `discriminatedUnion`: aprendo il discriminante, una risposta
   * valida della variante `b` può essere attribuita alla variante `a` e perdere
   * i suoi campi. Non è un caso che la validazione rigida del server
   * intercetti, perché quel payload è per lei perfettamente valido.
   *
   * Quindi qui NON si apre nulla, in due modi:
   * - una `discriminatedUnion` resta com'è sempre (ricostruirla come union
   *   semplice ne perderebbe anche il dispatch sul discriminante);
   * - una union semplice si ricostruisce SOLO se sotto di lei non è stato
   *   aperto niente; se qualcosa è stato aperto si torna l'originale RIGIDO.
   *
   * In entrambi i casi il tipo di nodo annotato è fuori da
   * {@link READER_NODE_KINDS}: la CI diventa rossa, e chi ci arriva progetta
   * l'apertura del discriminante apposta — per esempio
   * `z.union([originale_rigido, variante_di_fallback])`, col rigido per primo —
   * invece di scoprirlo da un bug su un telefono.
   */
  if (schema instanceof z.ZodDiscriminatedUnion) {
    trace.kinds.add("discriminatedUnion");
    return schema;
  }
  if (schema instanceof z.ZodUnion) {
    const openedBefore = trace.opened;
    const options = schema.options.map((option) => derive(child(option), trace));
    if (trace.opened > openedBefore) {
      noteRebuild(schema, "union(opened)", trace);
      return schema;
    }
    noteRebuild(schema, "union", trace);
    return z.union(options as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }

  if (schema instanceof z.ZodArray) {
    noteRebuild(schema, "array", trace);
    return z.array(derive(child(schema.element), trace));
  }
  if (schema instanceof z.ZodOptional) {
    noteRebuild(schema, "optional", trace);
    return derive(child(schema.unwrap()), trace).optional();
  }
  if (schema instanceof z.ZodNullable) {
    noteRebuild(schema, "nullable", trace);
    return derive(child(schema.unwrap()), trace).nullable();
  }

  // Foglia (string/number/boolean/unknown) o nodo non gestito: invariata, e
  // quindi anche i suoi `checks` sopravvivono.
  trace.kinds.add(schema.def.type);
  return schema;
}

/** I tipi di nodo Zod raggiungibili dallo schema, sul cammino di `readerSchema`. */
export function readerNodeKinds(schema: z.ZodType): Set<string> {
  const trace: Trace = { kinds: new Set(), opened: 0 };
  derive(schema, trace);
  return trace.kinds;
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
  const derived = derive(schema, { kinds: new Set(), opened: 0 }) as z.ZodType<Reader<z.output<S>>>;
  cache.set(schema, derived as unknown as z.ZodType);
  return derived;
}
