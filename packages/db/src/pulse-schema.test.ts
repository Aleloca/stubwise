import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { notificationSettings, notifications, projects, users } from "./schema.js";
import { expectSqlState, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione del pulse proattivo (fase 2) sia applicabile su un
 * Postgres reale: colonne di cadenza sul progetto (spento di default, 3 giorni,
 * mai inviato) col CHECK sull'intervallo ammesso, toggle `notify_pulse` del
 * webhook seedato a true e valore enum `project.pulse` inseribile in
 * `notifications`.
 */
describe("schema: pulse proattivo per progetto", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });


  /** Progetto minimo, con la cadenza del pulse eventualmente forzata. */
  async function seedProject(pulse: { pulseEveryDays?: number } = {}): Promise<string> {
    const [project] = await db
      .insert(projects)
      .values({
        name: "Progetto di test",
        slug: `progetto-${randomUUID()}`,
        ingestionKey: randomUUID(),
        ...pulse,
      })
      .returning();
    if (!project) throw new Error("insert del progetto non ha restituito la riga");
    return project.id;
  }

  it("projects: pulse spento di default, cadenza 3 giorni, mai inviato", async () => {
    const projectId = await seedProject();

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error("read del progetto non ha restituito la riga");
    // Opt-in esplicito: al deploy nessun progetto riceve il pulse.
    expect(project.pulseEnabled).toBe(false);
    expect(project.pulseEveryDays).toBe(3);
    expect(project.pulseLastSentAt).toBeNull();
  });

  it("projects: la cadenza accetta gli estremi 1 e 30 e rifiuta 0 e 31", async () => {
    const minimo = await seedProject({ pulseEveryDays: 1 });
    const massimo = await seedProject({ pulseEveryDays: 30 });
    const [uno] = await db.select().from(projects).where(eq(projects.id, minimo));
    const [trenta] = await db.select().from(projects).where(eq(projects.id, massimo));
    expect(uno?.pulseEveryDays).toBe(1);
    expect(trenta?.pulseEveryDays).toBe(30);

    // Sotto 1 il pulse diventerebbe un ping continuo, sopra 30 un promemoria
    // che non arriva mai: il CHECK chiude entrambi i versi.
    await expectSqlState(
      db.insert(projects).values({
        name: "Progetto di test",
        slug: `progetto-${randomUUID()}`,
        ingestionKey: randomUUID(),
        pulseEveryDays: 0,
      }),
      "23514",
    );
    await expectSqlState(
      db.insert(projects).values({
        name: "Progetto di test",
        slug: `progetto-${randomUUID()}`,
        ingestionKey: randomUUID(),
        pulseEveryDays: 31,
      }),
      "23514",
    );
    // Il CHECK vale anche in aggiornamento, non solo all'inserimento.
    await expectSqlState(
      db.update(projects).set({ pulseEveryDays: 45 }).where(eq(projects.id, minimo)),
      "23514",
    );
  });

  it("projects: pulseLastSentAt regge il gate di idempotenza (UPDATE condizionato)", async () => {
    const projectId = await seedProject();
    // Valore letto dal tick: null (mai inviato). Il primo UPDATE condizionato su
    // quel valore passa, il secondo — un tick concorrente che aveva letto lo
    // stesso null — non trova più righe e non manda un secondo pulse.
    const inviatoA = new Date();
    const primo = await db
      .update(projects)
      .set({ pulseLastSentAt: inviatoA })
      .where(sql`${projects.id} = ${projectId} and pulse_last_sent_at is null`)
      .returning();
    expect(primo).toHaveLength(1);
    expect(primo[0]?.pulseLastSentAt).toBeInstanceOf(Date);

    const secondo = await db
      .update(projects)
      .set({ pulseLastSentAt: new Date() })
      .where(sql`${projects.id} = ${projectId} and pulse_last_sent_at is null`)
      .returning();
    expect(secondo).toHaveLength(0);
  });

  it("notification_settings: seeda notify_pulse a true (id=1)", async () => {
    const [settings] = await db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.id, 1));
    expect(settings?.notifyPulse).toBe(true);
  });

  it("notifications: il kind project.pulse è accettato e non ha ticket né job", async () => {
    const projectId = await seedProject();
    const [user] = await db
      .insert(users)
      .values({
        email: `destinatario-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
      })
      .returning();
    if (!user) throw new Error("insert dell'utente non ha restituito la riga");

    const [notifica] = await db
      .insert(notifications)
      .values({
        userId: user.id,
        projectId,
        kind: "project.pulse",
        event: {
          kind: "project.pulse",
          projectName: "Progetto di test",
          projectUrl: "https://example.com/backlog",
          idleDays: 5,
        },
      })
      .returning();
    if (!notifica) throw new Error("insert della notifica non ha restituito la riga");
    expect(notifica.kind).toBe("project.pulse");
    expect(notifica.ticketId).toBeNull();
    expect(notifica.jobId).toBeNull();
    expect(notifica.status).toBe("open");
  });
});
