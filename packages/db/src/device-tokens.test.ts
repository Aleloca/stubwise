import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  deviceTokens,
  notificationDeliveries,
  notifications,
  personalAccessTokens,
  users,
} from "./schema.js";
import { seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione delle push verso l'app mobile (0067) sia
 * applicabile su un Postgres reale: la tabella `device_tokens` coi suoi
 * default, l'unicità del token, il CHECK sulla piattaforma, le due FK con
 * politiche di cancellazione diverse (utente in cascata, PAT a NULL), il
 * default di `users.notify_push` e il canale di consegna `push`.
 */
describe("schema: device token e canale push", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  /**
   * Esegue una query che deve fallire e ne verifica il codice SQLSTATE, così il
   * test non passa per un errore diverso da quello atteso (23514 = violazione di
   * CHECK, 23505 = violazione di unique/PK). drizzle incarta l'errore del driver
   * in un `DrizzleQueryError`: il `PostgresError` col codice arriva come `cause`.
   */
  async function expectSqlState(query: PromiseLike<unknown>, sqlState: string): Promise<void> {
    try {
      await query;
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause ?? err;
      expect((cause as { code?: string }).code).toBe(sqlState);
      return;
    }
    throw new Error(`la query doveva fallire con SQLSTATE ${sqlState}, invece è riuscita`);
  }

  async function seedUser(): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({
        email: `mobile-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
      })
      .returning();
    if (!user) throw new Error("insert dell'utente non ha restituito la riga");
    return user.id;
  }

  it("users: notifyPush default true", async () => {
    const userId = await seedUser();
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user?.notifyPush).toBe(true);
  });

  it("device token: default della riga e campi opzionali nulli", async () => {
    const userId = await seedUser();
    const [device] = await db
      .insert(deviceTokens)
      .values({ userId, platform: "ios", token: `tok-${randomUUID()}` })
      .returning();
    if (!device) throw new Error("insert del device non ha restituito la riga");

    expect(device.patId).toBeNull();
    expect(device.appVersion).toBeNull();
    // Un device nasce attivo: è `disabledAt` a togliere una riga dal giro.
    expect(device.disabledAt).toBeNull();
    expect(device.disabledReason).toBeNull();
    expect(device.lastSeenAt).toBeInstanceOf(Date);
    expect(device.createdAt).toBeInstanceOf(Date);
  });

  it("device token: `token` è unico anche fra utenti diversi", async () => {
    // Il token lo assegna il sistema operativo e può essere riassegnato a
    // un'altra installazione: due righe con lo stesso token manderebbero la
    // stessa push due volte, o alla persona sbagliata.
    const token = `tok-${randomUUID()}`;
    await db.insert(deviceTokens).values({ userId: await seedUser(), platform: "ios", token });
    await expectSqlState(
      db.insert(deviceTokens).values({ userId: await seedUser(), platform: "android", token }),
      "23505",
    );
  });

  it("device token: `platform` accetta solo ios e android", async () => {
    // Insert raw: il tipo drizzle vieterebbe già il valore a compile-time, qui
    // si verifica che sia il CHECK di Postgres a farlo rispettare a runtime.
    const userId = await seedUser();
    await expectSqlState(
      db.execute(sql`
        insert into device_tokens (user_id, platform, token)
        values (${userId}, 'web', ${`tok-${randomUUID()}`})
      `),
      "23514",
    );
  });

  it("device token: cascata sul delete dell'utente", async () => {
    const userId = await seedUser();
    const [device] = await db
      .insert(deviceTokens)
      .values({ userId, platform: "android", token: `tok-${randomUUID()}` })
      .returning();
    if (!device) throw new Error("insert del device non ha restituito la riga");

    await db.delete(users).where(eq(users.id, userId));
    expect(await db.select().from(deviceTokens).where(eq(deviceTokens.id, device.id))).toHaveLength(
      0,
    );
  });

  it("device token: revocare il PAT azzera `patId` ma lascia vivo il device", async () => {
    // Revocare un token è un'operazione di credenziali, non di recapito: la
    // riga sopravvive e resta disattivabile a parte.
    const userId = await seedUser();
    const [pat] = await db
      .insert(personalAccessTokens)
      .values({ userId, name: "iPhone", tokenHash: `hash-${randomUUID()}` })
      .returning();
    if (!pat) throw new Error("insert del PAT non ha restituito la riga");

    const [device] = await db
      .insert(deviceTokens)
      .values({ userId, patId: pat.id, platform: "ios", token: `tok-${randomUUID()}` })
      .returning();
    if (!device) throw new Error("insert del device non ha restituito la riga");

    await db.delete(personalAccessTokens).where(eq(personalAccessTokens.id, pat.id));
    const [rimasto] = await db.select().from(deviceTokens).where(eq(deviceTokens.id, device.id));
    expect(rimasto?.patId).toBeNull();
  });

  it("delivery_channel accetta `push`", async () => {
    // Il canale è per DESTINATARIO, quindi la consegna ha una notifica dietro:
    // il CHECK `channel_shape` ammette `notification_id` null solo per il
    // webhook d'istanza.
    const { projectId, ticketId } = await seedTicket(db);
    const userId = await seedUser();
    const [notifica] = await db
      .insert(notifications)
      .values({
        userId,
        projectId,
        ticketId,
        kind: "ticket.created",
        event: { kind: "ticket.created" },
      })
      .returning();
    if (!notifica) throw new Error("insert della notifica non ha restituito la riga");

    const [delivery] = await db
      .insert(notificationDeliveries)
      .values({ notificationId: notifica.id, channel: "push" })
      .returning();
    expect(delivery?.channel).toBe("push");
  });
});
