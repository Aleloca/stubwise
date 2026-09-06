import { isPgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import * as schema from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Parità fra gli enum dichiarati in `schema.ts` e i tipi enum realmente
 * esistenti in Postgres dopo la catena completa delle migrazioni.
 *
 * Serve perché le due cose si scrivono in posti diversi e nessuno le lega: i
 * valori stanno in `schema.ts` (o, per gli enum derivati, in uno schema Zod di
 * `@stubwise/shared`), mentre il tipo Postgres nasce e cambia solo con uno
 * statement `CREATE TYPE` / `ALTER TYPE … ADD VALUE` scritto a mano in una
 * migrazione. Il repo non usa `drizzle-kit generate` (l'ultimo snapshot in
 * `drizzle/meta/` è il 0060), quindi NIENTE si accorge da solo di uno scarto.
 *
 * I tre modi di sbagliare che questo test intercetta:
 *  - AGGIUNGERE un valore senza migrazione: TypeScript lo accetta ovunque, poi
 *    Postgres rifiuta il primo INSERT con `invalid input value for enum`;
 *  - RIMUOVERE o RINOMINARE un valore: il tipo TS si restringe, ma le righe col
 *    valore vecchio restano nel DB e chi le legge le trova fuori dal tipo;
 *  - RIORDINARE i valori: innocuo per la validazione, ma l'ordine è parte del
 *    tipo Postgres (`enumsortorder`, che governa `ORDER BY` su una colonna enum).
 *
 * Un test solo copre tutti gli enum, derivati da Zod e letterali: quelli nuovi
 * entrano da sé, senza che nessuno debba ricordarsi di aggiungerli qui.
 */
describe("parità enum schema.ts ↔ Postgres", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("ogni pgEnum di schema.ts esiste in Postgres con gli stessi valori, nello stesso ordine", async () => {
    // L'allargamento a `unknown[]` è necessario: `Object.values` su un import
    // di namespace produce l'unione di tutti gli export (enum E tabelle), e il
    // type guard di drizzle (`obj is PgEnum<[string, ...string[]]>`) non è
    // assegnabile a quell'unione di enum concreti, quindi non aggancia.
    const declared = (Object.values(schema) as unknown[]).filter(isPgEnum);
    // Guardia contro un filtro che smette di riconoscere gli enum (upgrade di
    // drizzle, export riorganizzati): un array vuoto passerebbe il loop.
    expect(declared.length).toBeGreaterThan(30);

    const rows = await db.execute<{ typname: string; labels: string[] }>(sql`
      select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'
      group by t.typname
    `);
    const inPostgres = new Map(rows.map((row) => [row.typname, row.labels]));

    for (const pgEnum of declared) {
      expect(inPostgres.get(pgEnum.enumName), `enum ${pgEnum.enumName}`).toEqual([
        ...pgEnum.enumValues,
      ]);
    }
  });
});
