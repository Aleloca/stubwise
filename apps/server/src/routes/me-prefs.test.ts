import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { deviceTokens, projectFollows, users } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * Test di `/api/me/follows`, `/api/me/notification-prefs` e `/api/me/devices`:
 * le preferenze PERSONALI dell'utente autenticato. Il punto delicato è
 * l'isolamento — ogni utente vede e scrive solo le proprie righe — e la
 * sostituzione atomica dell'insieme dei progetti seguiti.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let seeded: SeededUsers;
let projectA: string;
let projectB: string;
/** PAT in chiaro dell'admin: serve a registrare un device COME fa l'app. */
let adminPat: string;
/** Id della riga `personal_access_tokens` dietro {@link adminPat}. */
let adminPatId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({
    db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  seeded = await seedUsers(app);
  ({ projectId: projectA } = await seedRepository(db));
  ({ projectId: projectB } = await seedRepository(db));
  const pat = await app.inject({
    method: "POST",
    url: "/api/pats",
    headers: { cookie: seeded.adminCookie },
    payload: { name: "iPhone di test" },
  });
  if (pat.statusCode !== 201) throw new Error(`creazione PAT fallita: ${pat.body}`);
  ({ token: adminPat, id: adminPatId } = pat.json() as { token: string; id: string });
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  await db.delete(projectFollows);
  await db.delete(deviceTokens);
});

function getFollows(cookie = seeded.adminCookie) {
  return app.inject({ method: "GET", url: "/api/me/follows", headers: { cookie } });
}

function putFollows(projectIds: string[], cookie = seeded.adminCookie) {
  return app.inject({
    method: "PUT",
    url: "/api/me/follows",
    headers: { cookie },
    payload: { projectIds },
  });
}

function getPrefs(cookie = seeded.adminCookie) {
  return app.inject({ method: "GET", url: "/api/me/notification-prefs", headers: { cookie } });
}

/** PATCH: si mandano i soli campi da cambiare, non l'insieme intero. */
function patchPrefs(
  prefs: { slackDm?: boolean; push?: boolean },
  cookie = seeded.adminCookie,
) {
  return app.inject({
    method: "PATCH",
    url: "/api/me/notification-prefs",
    headers: { cookie },
    payload: prefs,
  });
}

/**
 * Registrazione di un device COME la fa l'app: il token nel body, non nel path.
 * `auth` è un header intero (cookie di sessione o `Bearer` di un PAT) perché
 * la differenza fra le due porte è ESATTAMENTE ciò che questi test misurano.
 */
function putDevice(
  body: Record<string, unknown>,
  auth: Record<string, string> = { cookie: seeded.adminCookie },
) {
  return app.inject({ method: "PUT", url: "/api/me/devices", headers: auth, payload: body });
}

/**
 * Logout dell'app: `POST` con il token nel BODY. Non è un
 * `DELETE /devices/:token` di proposito — pino logga l'URL intero e il token
 * finirebbe in chiaro nei log (vedi il docblock della rotta).
 */
function deleteDevice(token: string, auth: Record<string, string> = { cookie: seeded.adminCookie }) {
  return app.inject({
    method: "POST",
    url: "/api/me/devices/delete",
    headers: auth,
    payload: { token },
  });
}

/** La riga di `device_tokens` con quel token, o undefined. */
async function deviceRow(token: string) {
  const [row] = await db.select().from(deviceTokens).where(eq(deviceTokens.token, token));
  return row;
}

describe("autenticazione", () => {
  it("tutte le rotte /api/me rispondono 401 senza sessione", async () => {
    const calls = [
      app.inject({ method: "GET", url: "/api/me/follows" }),
      app.inject({ method: "PUT", url: "/api/me/follows", payload: { projectIds: [] } }),
      app.inject({ method: "GET", url: "/api/me/notification-prefs" }),
      app.inject({
        method: "PATCH",
        url: "/api/me/notification-prefs",
        payload: { slackDm: true, push: true },
      }),
      app.inject({
        method: "PUT",
        url: "/api/me/devices",
        payload: { platform: "ios", token: "tok-anonimo" },
      }),
      app.inject({
        method: "POST",
        url: "/api/me/devices/delete",
        payload: { token: "tok-anonimo" },
      }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("/api/me/follows", () => {
  it("parte da un insieme vuoto", async () => {
    const res = await getFollows();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projectIds: [] });
  });

  it("PUT sostituisce l'insieme (non aggiunge)", async () => {
    expect((await putFollows([projectA, projectB])).statusCode).toBe(204);
    expect(((await getFollows()).json() as { projectIds: string[] }).projectIds.sort()).toEqual(
      [projectA, projectB].sort(),
    );

    expect((await putFollows([projectB])).statusCode).toBe(204);
    expect((await getFollows()).json()).toEqual({ projectIds: [projectB] });

    expect((await putFollows([])).statusCode).toBe(204);
    expect((await getFollows()).json()).toEqual({ projectIds: [] });
  });

  it("è idempotente e tollera i duplicati nel payload", async () => {
    expect((await putFollows([projectA, projectA])).statusCode).toBe(204);
    expect((await getFollows()).json()).toEqual({ projectIds: [projectA] });
    expect((await putFollows([projectA])).statusCode).toBe(204);
    expect((await getFollows()).json()).toEqual({ projectIds: [projectA] });
  });

  it("400 unknown_project su un progetto inesistente, senza scrivere nulla", async () => {
    await putFollows([projectA]);
    const res = await putFollows([projectA, randomUUID()]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "unknown_project" });
    // L'insieme precedente resta intatto: la sostituzione è tutto-o-niente.
    expect((await getFollows()).json()).toEqual({ projectIds: [projectA] });
  });

  it("rifiuta un id non-uuid", async () => {
    const res = await putFollows(["non-un-uuid"]);
    expect(res.statusCode).toBe(400);
  });

  it("i follow di un utente non si vedono dall'altro", async () => {
    await putFollows([projectA], seeded.adminCookie);
    await putFollows([projectB], seeded.memberCookie);
    expect((await getFollows(seeded.adminCookie)).json()).toEqual({ projectIds: [projectA] });
    expect((await getFollows(seeded.memberCookie)).json()).toEqual({ projectIds: [projectB] });
    // La sostituzione dell'admin non tocca le righe del member.
    await putFollows([], seeded.adminCookie);
    expect((await getFollows(seeded.memberCookie)).json()).toEqual({ projectIds: [projectB] });
  });
});

describe("/api/me/notification-prefs", () => {
  it("GET: default acceso, ma senza identità Slack collegata", async () => {
    const res = await getPrefs();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ slackDm: true, push: true, slackLinked: false });
  });

  it("PATCH aggiorna i toggle e non tocca gli altri utenti", async () => {
    expect((await patchPrefs({ slackDm: false, push: false })).statusCode).toBe(204);
    expect((await getPrefs()).json()).toMatchObject({ slackDm: false, push: false });
    expect((await getPrefs(seeded.memberCookie)).json()).toMatchObject({
      slackDm: true,
      push: true,
    });

    expect((await patchPrefs({ slackDm: true, push: true })).statusCode).toBe(204);
    expect((await getPrefs()).json()).toMatchObject({ slackDm: true, push: true });
  });

  it("PATCH: un body col solo slackDm non azzera push", async () => {
    // È la proprietà che rende sicuro aggiungere un canale: un client vecchio
    // manda solo i campi che conosceva e non spegne quelli che ignora.
    expect((await patchPrefs({ slackDm: true, push: true })).statusCode).toBe(204);
    expect((await patchPrefs({ slackDm: false })).statusCode).toBe(204);
    expect((await getPrefs()).json()).toMatchObject({ slackDm: false, push: true });
  });

  it("PATCH: un body col solo push non azzera slackDm", async () => {
    expect((await patchPrefs({ slackDm: true, push: true })).statusCode).toBe(204);
    expect((await patchPrefs({ push: false })).statusCode).toBe(204);
    expect((await getPrefs()).json()).toMatchObject({ slackDm: true, push: false });
  });

  it("PATCH: un body vuoto è un no-op da 204, non un 400", async () => {
    expect((await patchPrefs({ slackDm: false, push: false })).statusCode).toBe(204);
    expect((await patchPrefs({})).statusCode).toBe(204);
    expect((await getPrefs()).json()).toMatchObject({ slackDm: false, push: false });
  });

  it("slackLinked segue users.slack_user_id", async () => {
    await db
      .update(users)
      .set({ slackUserId: `U${randomUUID().replace(/-/g, "").slice(0, 8)}` })
      .where(eq(users.id, seeded.adminId));
    expect((await getPrefs()).json()).toMatchObject({ slackLinked: true });
    await db.update(users).set({ slackUserId: null }).where(eq(users.id, seeded.adminId));
    expect((await getPrefs()).json()).toMatchObject({ slackLinked: false });
  });

  it("rifiuta un campo sconosciuto: un typo non deve passare per successo", async () => {
    // Il gemello di «un body vuoto è un no-op da 204», e i due vanno letti
    // insieme: `{}` è 204
    // perché una patch vuota è legittima, ma `{ pussh: false }` NON deve
    // finire nello stesso 204 — con tutti i campi opzionali lo strip lo
    // ridurrebbe a `{}` e il client crederebbe di aver salvato. Da qui lo
    // `.strict()` sul solo schema di update.
    const res = await app.inject({
      method: "PATCH",
      url: "/api/me/notification-prefs",
      headers: { cookie: seeded.adminCookie },
      payload: { pussh: false },
    });
    expect(res.statusCode).toBe(400);
    // Il nome sbagliato dev'essere NEL messaggio: è l'informazione che serve a
    // chi ha fatto il typo, e senza di essa il 400 è solo un muro.
    expect(JSON.stringify(res.json())).toContain("pussh");
  });

  it("rifiuta un campo presente col tipo sbagliato", async () => {
    // Opzionale non vuol dire libero: se il campo c'è, deve essere un boolean.
    const res = await app.inject({
      method: "PATCH",
      url: "/api/me/notification-prefs",
      headers: { cookie: seeded.adminCookie },
      payload: { slackDm: "si" },
    });
    expect(res.statusCode).toBe(400);
  });
});
describe("/api/me/devices", () => {
  const PAT_AUTH = () => ({ authorization: `Bearer ${adminPat}` });

  it("PUT con PAT: 204 e la riga porta il patId di QUEL token", async () => {
    // Il `patId` è ciò che lega il device alla credenziale con cui è stato
    // registrato: senza, revocare il PAT del telefono perso non saprebbe quali
    // device spegnere (vedi il DELETE di `routes/pat.ts`).
    expect(
      (await putDevice({ platform: "ios", token: "tok-pat", appVersion: "1.2.3" }, PAT_AUTH()))
        .statusCode,
    ).toBe(204);
    const row = await deviceRow("tok-pat");
    expect(row).toMatchObject({
      userId: seeded.adminId,
      patId: adminPatId,
      platform: "ios",
      appVersion: "1.2.3",
      disabledAt: null,
      disabledReason: null,
    });
  });

  it("PUT con cookie di sessione: 204 e patId null", async () => {
    // Registrare dal web è legittimo e non ha un PAT dietro: la colonna resta
    // null e la revoca di un PAT altrui non deve poterla toccare.
    expect((await putDevice({ platform: "android", token: "tok-web" })).statusCode).toBe(204);
    expect(await deviceRow("tok-web")).toMatchObject({
      userId: seeded.adminId,
      patId: null,
      appVersion: null,
    });
  });

  it("PUT è idempotente e aggiorna i campi (una sola riga per token)", async () => {
    await putDevice({ platform: "ios", token: "tok-idem", appVersion: "1.0.0" });
    await putDevice({ platform: "ios", token: "tok-idem", appVersion: "2.0.0" });
    const rows = await db.select().from(deviceTokens).where(eq(deviceTokens.token, "tok-idem"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.appVersion).toBe("2.0.0");
  });

  it("PUT RIATTIVA un device disabilitato, azzerando istante E motivo", async () => {
    // È il caso che rende inutile tutto il resto se sbagliato: dopo la revoca
    // del PAT (o un `invalid_token` dal relay) la riga resta disattivata, e se
    // il ri-login non la riaccendesse quel telefono resterebbe muto PER
    // SEMPRE — senza nessun errore da nessuna parte. `disabled_at` e
    // `disabled_reason` vanno azzerati INSIEME: il CHECK
    // `device_tokens_disabled_chk` li vuole entrambi null o entrambi
    // valorizzati, e azzerarne uno solo darebbe un 23514 a runtime.
    await putDevice({ platform: "ios", token: "tok-spento" }, PAT_AUTH());
    await db
      .update(deviceTokens)
      .set({ disabledAt: new Date(), disabledReason: "pat_revoked" })
      .where(eq(deviceTokens.token, "tok-spento"));
    expect((await putDevice({ platform: "ios", token: "tok-spento" })).statusCode).toBe(204);
    expect(await deviceRow("tok-spento")).toMatchObject({
      disabledAt: null,
      disabledReason: null,
    });
  });

  it("PUT dello stesso token da un altro utente: il device PASSA al nuovo utente", async () => {
    // Il token identifica l'INSTALLAZIONE, non la persona: su un telefono dove
    // A esce e B entra, il token del sistema operativo è lo stesso. Senza
    // questo passaggio la registrazione di B sbatterebbe contro la unique e
    // quel telefono non riceverebbe mai una push. Il prezzo — chi conosce un
    // token altrui se lo può intestare — è discusso nel report del task.
    await putDevice({ platform: "ios", token: "tok-condiviso" }, { cookie: seeded.adminCookie });
    expect(
      (await putDevice({ platform: "ios", token: "tok-condiviso" }, { cookie: seeded.memberCookie }))
        .statusCode,
    ).toBe(204);
    const rows = await db.select().from(deviceTokens).where(eq(deviceTokens.token, "tok-condiviso"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(seeded.memberId);
  });

  it("cancellare: la riga sparisce, non viene disabilitata", async () => {
    // Logout = via. Una riga soft-deleted resterebbe a occupare la unique sul
    // token e a farsi riaccendere dal primo upsert di chiunque.
    await putDevice({ platform: "ios", token: "tok-logout" });
    expect((await deleteDevice("tok-logout")).statusCode).toBe(204);
    expect(await deviceRow("tok-logout")).toBeUndefined();
  });

  it("cancellare il token di un ALTRO utente: 204, ma la riga altrui resta INTATTA", async () => {
    // Il test che la previsione del revisore chiedeva. Il 204 non prova nulla:
    // senza `userId` nel WHERE risponderebbe 204 ESATTAMENTE come adesso, e
    // avrebbe cancellato la riga. È il DB a dover essere guardato.
    await putDevice({ platform: "ios", token: "tok-altrui" }, { cookie: seeded.memberCookie });
    const prima = await deviceRow("tok-altrui");
    expect((await deleteDevice("tok-altrui", { cookie: seeded.adminCookie })).statusCode).toBe(204);
    const dopo = await deviceRow("tok-altrui");
    expect(dopo).toBeDefined();
    expect(dopo?.id).toBe(prima?.id);
    expect(dopo?.userId).toBe(seeded.memberId);
    // E il member lo cancella eccome: il 204 di prima non era un permesso
    // negato per tutti, era negato per l'admin.
    expect((await deleteDevice("tok-altrui", { cookie: seeded.memberCookie })).statusCode).toBe(204);
    expect(await deviceRow("tok-altrui")).toBeUndefined();
  });

  it("un token con caratteri speciali attraversa il body senza codifiche", async () => {
    // Stesso token di prima, motivo nuovo. Finché stava nel path, `/` era il
    // carattere che rompeva il routing se qualcuno smetteva di codificarlo;
    // ora che sta nel body non c'è più niente da codificare, e questo test
    // serve a dimostrare proprio quello — che il giro completo torna alla riga
    // giusta con il token GREZZO, così nessuno reintroduce un
    // `encodeURIComponent` "per sicurezza" (codificherebbe il token e la
    // cancellazione non troverebbe più nulla, in silenzio, con un 204).
    const token = "abc/def:ghi_jkl-mno";
    expect((await putDevice({ platform: "ios", token })).statusCode).toBe(204);
    expect((await deleteDevice(token)).statusCode).toBe(204);
    expect(await deviceRow(token)).toBeUndefined();
  });

  it("cancellare un token inesistente: 204, non 404", async () => {
    // Il logout dev'essere idempotente: l'app lo ritenta dopo un timeout di
    // rete e non deve inciampare in un errore per un lavoro già fatto. Un 404
    // direbbe anche «questo token non è tuo o non esiste», che è più di quanto
    // serva a chi sta uscendo.
    expect((await deleteDevice("tok-mai-esistito")).statusCode).toBe(204);
  });

  it("la cancellazione rifiuta un body senza token", async () => {
    // Il token è nel body, quindi è il body a doverlo validare: senza questo,
    // un client che manda `{}` cancellerebbe... nulla, ma con un 204 che gli
    // direbbe di sì.
    const res = await app.inject({
      method: "POST",
      url: "/api/me/devices/delete",
      headers: { cookie: seeded.adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rifiuta una piattaforma fuori dai valori ammessi", async () => {
    // Speculare al CHECK `device_tokens_platform_chk`: qui il 400 arriva PRIMA
    // del DB, che altrimenti risponderebbe con un 500 da 23514.
    expect((await putDevice({ platform: "web", token: "tok-web-platform" })).statusCode).toBe(400);
  });

  it("rifiuta un body senza token e un token vuoto", async () => {
    expect((await putDevice({ platform: "ios" })).statusCode).toBe(400);
    expect((await putDevice({ platform: "ios", token: "" })).statusCode).toBe(400);
  });
});
