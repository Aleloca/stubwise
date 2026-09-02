import { randomBytes } from "node:crypto";
import { and, count, desc, eq, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth/password.js";
import {
  createSession,
  deleteSession,
  requireAdmin,
  requireAuth,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionIdFromRequest,
  toSessionUser,
} from "../auth/session.js";
import type { SessionUserColumns } from "../auth/session.js";
import { invites, sessions, users } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import {
  authUserResponseSchema,
  languageResponseSchema,
  languageSchema,
  mobileLoginBodySchema,
  mobileLoginResponseSchema,
  sessionResponseSchema,
  setupStatusSchema,
} from "@stubwise/shared";
import { createPatForUser } from "./pat.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";
import type { RateLimitConfig } from "./shared.js";
import { apiError } from "../errors.js";
import { loadSlackCreds, defaultSlackClientFactory, type SlackClientFactory } from "../slack/creds.js";

export interface AuthRoutesOptions {
  /**
   * Limite per IP applicato a login, mobile-login e register: tutte pagano una
   * verifica o un hash argon2 (deliberatamente costoso), che senza limite
   * sarebbe un vettore di DoS.
   *
   * `/login` e `/mobile-login` condividono UN SOLO bucket (sono due porte sulle
   * stesse credenziali: il tetto è della superficie, non della rotta).
   * `/register` ne ha uno proprio: consuma un invito, non prova una password.
   */
  rateLimit: RateLimitConfig;
  /**
   * Fabbrica del client Slack, per gli inviti originati dal workspace Slack
   * (POST /invites con slackUserId): email/avatar sono derivati server-side dal
   * profilo Slack, mai dal client. Default: client reale via fetch globale.
   * Fake nei test.
   */
  slackClientFactory?: SlackClientFactory;
}

/** Validità di un link di invito: 7 giorni. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Chiave del lock advisory di Postgres che serializza il primo setup.
 * Valore arbitrario ma fisso: deve solo essere unico nell'applicazione.
 */
const SETUP_LOCK_KEY = 7_414_355;

/**
 * Hash argon2id fittizio, calcolato pigramente al primo login e poi
 * memoizzato. Al login, se l'email non esiste, la password viene comunque
 * verificata contro questo hash: entrambi i rami costano una verifica argon2
 * e il tempo di risposta non rivela se l'account esiste.
 * Lazy (non promise top-level): un eventuale errore resta gestibile nella
 * richiesta invece di diventare un'unhandled rejection al caricamento.
 */
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("stubwise-dummy-password").catch((error) => {
    // Niente memoizzazione del fallimento: il prossimo login ritenta.
    dummyHashPromise = undefined;
    throw error;
  });
  return dummyHashPromise;
}

/**
 * Verifica email+password e restituisce l'utente, oppure `null` se le
 * credenziali non sono valide — SENZA dire quale dei due motivi.
 *
 * Vive qui, in una funzione sola, perché è la difesa anti-enumerazione e ha
 * più di un chiamante (`/login` per il web, `/mobile-login` per l'app): due
 * copie della sequenza sarebbero due occasioni di farla divergere, e la
 * divergenza è esattamente il buco. Entrambi i rami pagano una verifica
 * argon2 — quello senza utente contro l'hash fittizio — quindi né il corpo
 * della risposta né il tempo per produrla dicono se l'account esiste.
 *
 * Chi chiama deve rispondere allo stesso identico modo per ogni `null`.
 *
 * L'utente esce SENZA `passwordHash`, e per ALLOWLIST: si elencano le colonne
 * che escono invece di togliere quella che non deve uscire. È la stessa regola
 * di `toPatView` per il `tokenHash` (`routes/pat.ts`) — "mai lo spread della
 * riga" — ed è più forte di un `Omit`: una colonna sensibile aggiunta domani a
 * `users` non entra qui da sola. Serve perché questa funzione è l'unico punto
 * di `auth.ts` da cui l'hash potrebbe uscire, e lo schema zod di risposta fa
 * da rete solo dove una rotta ne dichiara uno: il prossimo chiamante
 * potrebbe non averlo.
 *
 * Le colonne sono esattamente quelle che consuma `toSessionUser`, cioè quanto
 * basta a entrambi i chiamanti.
 */
async function verifyCredentials(
  db: Db,
  email: string,
  password: string,
): Promise<SessionUserColumns | null> {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    await verifyPassword(await getDummyHash(), password);
    return null;
  }
  if (!(await verifyPassword(user.passwordHash, password))) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    language: user.language,
    slackAvatarUrl: user.slackAvatarUrl,
    slackUserId: user.slackUserId,
  };
}

/**
 * Le rotte di `authRoutes` che possono legittimamente avere un bucket di rate
 * limit tutto loro. Confronto per suffisso e non per url intera perché il
 * prefisso (`/api/auth`) lo decide chi registra il plugin.
 */
const OWN_BUCKET_ROUTES = ["/register"];

/**
 * Descrive la violazione se una rotta di `authRoutes` dichiara
 * `config.rateLimit` invece di montare il limiter condiviso, altrimenti
 * `null`. Estratta dall'hook perché una guardia non testabile è solo un
 * commento più lungo: `auth-rate-limit-guard.test.ts` la esercita da sola,
 * senza dover registrare una rotta finta.
 *
 * `config.rateLimit === false` (limite esplicitamente disattivato) non è una
 * violazione: non apre nessun bucket.
 */
export function credentialsBucketViolation(
  url: string,
  config: { rateLimit?: unknown } | undefined,
): string | null {
  if (!config?.rateLimit) return null;
  if (OWN_BUCKET_ROUTES.some((suffix) => url.endsWith(suffix))) return null;
  return (
    `${url}: le rotte di autenticazione condividono un solo tetto di tentativi. ` +
    "Monta `credentialsRateLimit` come onRequest invece di dichiarare " +
    "`config.rateLimit`, che aprirebbe un bucket a sé e alzerebbe il tetto " +
    `per IP (vedi il commento su credentialsRateLimit; eccezioni: ${OWN_BUCKET_ROUTES.join(", ")}).`
  );
}

const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8, "la password deve avere almeno 8 caratteri"),
});

/** Opzioni condivise del cookie di sessione (set e clear devono combaciare). */
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: "auto",
} as const;

/**
 * Route di autenticazione, registrate sotto /api/auth.
 * Sessioni opache: il cookie contiene solo l'id (firmato), lo stato vive
 * nella tabella `sessions`.
 */
export async function authRoutes(
  instance: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const slackClientFactory = opts.slackClientFactory ?? defaultSlackClientFactory;

  /**
   * UN SOLO limiter, condiviso da `/login` e `/mobile-login`.
   *
   * PERCHÉ: il tetto anti-brute-force è una proprietà della SUPERFICIE
   * CREDENZIALI, non della singola rotta. Sono due porte sulla stessa
   * password: se ognuna avesse il suo bucket, aggiungerne una raddoppierebbe
   * i tentativi al minuto per IP senza che nessun numero in configurazione
   * cambi. Chi aggiungerà una TERZA porta sulle credenziali — un magic link,
   * un SSO, un rinnovo di token — la attacchi a QUESTO handler invece di
   * dichiarare `config.rateLimit`, altrimenti apre un terzo bucket e alza il
   * tetto un'altra volta.
   *
   * PERCHÉ COSÌ e non con `groupId`: in @fastify/rate-limit 11 `groupId` NON
   * unisce i bucket di due rotte diverse, malgrado il README lo presenti così.
   * Ogni `config.rateLimit` di rotta riceve il proprio store da `store.child()`
   * — che per lo store in memoria è una LRU nuova di zecca (e per quello Redis
   * un prefisso di chiave `<metodo><url>-`), quindi `groupId` cambia solo la
   * chiave DENTRO un contenitore già separato. `app.rateLimit()` invece crea il
   * limiter — e il suo store — UNA volta: montando lo stesso handler su
   * entrambe le rotte, il contenitore è davvero uno. I due test "tetto
   * condiviso con /login" falliscono con `groupId` e passano così; sono lì
   * perché la differenza non si vede leggendo il codice.
   *
   * ⚠️ E IL BUG SPECULARE, per chi un giorno monterà un SECONDO limiter a mano
   * su un'altra superficie (l'ingestion, il widget…). Il prefisso di chiave
   * `<metodo><url>-` dello store Redis viene da `routeInfo`, che
   * `config.rateLimit` valorizza con la rotta vera ma che `app.rateLimit()`
   * passa VUOTO (`routeInfo: {}`): il prefisso diventa la costante
   * `undefinedundefined-`, uguale per tutti. Con lo store in memoria non si
   * vede (ogni limiter ha comunque la sua LRU), ma con Redis due limiter
   * montati a mano si FONDEREBBERO per IP — il tetto di una superficie
   * consumato dai tentativi su un'altra. È la fusione silenziosa, l'esatto
   * opposto del problema di `groupId`, e oggi non morde solo perché di
   * limiter montati a mano ce n'è uno. Il secondo passi un `nameSpace`
   * proprio, o torni a `config.rateLimit` se non deve condividere niente.
   *
   * `onRequest` come il `config.rateLimit` che sostituisce (è l'hook di
   * default del plugin): il conteggio resta prima del parsing del corpo, così
   * un corpo malformato costa comunque un tentativo.
   *
   * `/register` resta fuori dal gruppo, con il suo bucket: non verifica le
   * credenziali di un account esistente, consuma un invito. Non è una porta
   * sulla stessa password e il suo tetto è indipendente (lo asserisce un test
   * in `ingest.test.ts`).
   */
  const credentialsRateLimit = instance.rateLimit(opts.rateLimit);

  // La guardia che rende verificabile il paragrafo qui sopra: senza, "attacca
  // la prossima rotta a credentialsRateLimit" resta una frase in un commento,
  // e chi la salta apre un bucket nuovo senza che nessun test se ne accorga
  // (i due test alternati coprono login<->mobile, non una rotta che ancora non
  // esiste). Con, l'errore è all'AVVIO del server, non in produzione.
  instance.addHook("onRoute", (route) => {
    const problem = credentialsBucketViolation(route.url, route.config);
    if (problem) throw new Error(problem);
  });

  // La UI usa questo flag per decidere se mostrare la pagina di primo setup.
  app.get(
    "/setup",
    { schema: { response: { 200: setupStatusSchema } } },
    async () => {
      const [row] = await app.db.select({ value: count() }).from(users);
      return { needed: (row?.value ?? 0) === 0 };
    },
  );

  app.post(
    "/setup",
    {
      schema: {
        body: credentialsSchema,
        response: { 201: authUserResponseSchema, 403: errorSchema },
      },
    },
    async (request, reply) => {
      // Fast path: se un utente esiste già si rifiuta senza pagare l'hash.
      const [row] = await app.db.select({ value: count() }).from(users);
      if ((row?.value ?? 0) > 0) {
        return apiError(reply, 403, "setup_already_completed", "Setup already completed");
      }
      // Hash prima della transazione: il lock non va tenuto per la durata
      // (deliberatamente alta) di argon2.
      const passwordHash = await hashPassword(request.body.password);
      // Lock advisory di transazione + ricontrollo: due setup concorrenti
      // vengono serializzati e solo il primo crea l'admin.
      const user = await app.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
        const [recount] = await tx.select({ value: count() }).from(users);
        if ((recount?.value ?? 0) > 0) return null;
        const [created] = await tx
          .insert(users)
          .values({ email: request.body.email, passwordHash, role: "admin" })
          .returning();
        if (!created) throw new Error("insert dell'admin non ha restituito la riga");
        return created;
      });
      if (!user) {
        return apiError(reply, 403, "setup_already_completed", "Setup already completed");
      }
      return reply
        .code(201)
        .send({ user: { id: user.id, email: user.email, role: user.role } });
    },
  );

  app.post(
    "/login",
    {
      onRequest: credentialsRateLimit,
      schema: {
        // Nessun vincolo di lunghezza al login: la policy vale alla creazione.
        body: z.object({ email: z.email(), password: z.string().min(1) }),
        response: { 200: authUserResponseSchema, 401: errorSchema },
      },
    },
    async (request, reply) => {
      const user = await verifyCredentials(app.db, request.body.email, request.body.password);
      if (!user) {
        return apiError(reply, 401, "invalid_credentials", "Invalid credentials");
      }
      // Igiene opportunistica: le sessioni scadute dell'utente vengono
      // eliminate qui, così la tabella non accumula righe morte di chi
      // non riusa mai i vecchi cookie (la pulizia pigra in findSessionUser
      // scatta solo se il cookie scaduto viene ripresentato).
      await app.db
        .delete(sessions)
        .where(and(eq(sessions.userId, user.id), lte(sessions.expiresAt, sql`now()`)));
      const session = await createSession(app.db, user.id);
      return reply
        .setCookie(SESSION_COOKIE, session.id, {
          ...SESSION_COOKIE_OPTIONS,
          signed: true,
          maxAge: Math.floor(SESSION_TTL_MS / 1000),
        })
        .code(200)
        .send({ user: { id: user.id, email: user.email, role: user.role } });
    },
  );

  /**
   * Login dell'app mobile: stesse credenziali del web, ma invece di aprire una
   * sessione a cookie emette un Personal Access Token per QUEL device, che
   * l'app tiene nel Keychain e manda nell'header `authorization`.
   *
   * Un PAT per device, e non uno condiviso, perché è ciò che rende governabile
   * la revoca: il token si chiama `Mobile · <deviceName>`, l'utente lo
   * riconosce nella lista dei token e può buttare giù il telefono perso senza
   * sloggare gli altri — ed è la stessa riga che il logout dell'app revoca da
   * sé. Nessuna scadenza: la fine di un PAT mobile è la revoca, non il tempo.
   *
   * NON crea la sessione a cookie: sarebbe una riga in `sessions` che nessun
   * client chiuderà mai, per un client che non manda cookie.
   *
   * Condivide il bucket di rate limit con `/login` — non «lo stesso limite»,
   * proprio lo stesso contatore: sono due porte sulle stesse credenziali, e
   * bucket separati raddoppierebbero i tentativi disponibili a un attaccante.
   */
  app.post(
    "/mobile-login",
    {
      onRequest: credentialsRateLimit,
      schema: {
        body: mobileLoginBodySchema,
        response: { 200: mobileLoginResponseSchema, 400: errorSchema, 401: errorSchema },
      },
    },
    async (request, reply) => {
      const user = await verifyCredentials(app.db, request.body.email, request.body.password);
      // Identica, parola per parola, alla 401 di /login: le due rotte non
      // devono nemmeno distinguersi fra loro.
      if (!user) {
        return apiError(reply, 401, "invalid_credentials", "Invalid credentials");
      }
      const { token } = await createPatForUser(
        app.db,
        user.id,
        `Mobile · ${request.body.deviceName}`,
        null,
      );
      return reply.code(200).send({ token, user: toSessionUser(user) });
    },
  );

  // Best effort, senza requireAuth: il logout deve riuscire anche con cookie
  // assente, manomesso o già scaduto. Si elimina la riga solo se il cookie
  // si risolve; in ogni caso si pulisce il cookie e si risponde 204.
  app.post("/logout", async (request, reply) => {
    const sessionId = sessionIdFromRequest(request);
    if (sessionId) await deleteSession(app.db, sessionId);
    return reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS).code(204).send();
  });

  app.get(
    "/me",
    {
      preHandler: requireAuth,
      schema: {
        response: { 200: sessionResponseSchema, ...authErrorResponses },
      },
    },
    async (request) => ({ user: request.user! }),
  );

  // Ogni utente cambia solo la propria preferenza di lingua: l'id è quello
  // della sessione, mai dal body, quindi non serve un controllo di ruolo.
  app.patch(
    "/me",
    {
      preHandler: requireAuth,
      schema: {
        body: z.object({ language: languageSchema }),
        response: { 200: languageResponseSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { language } = request.body;
      await app.db.update(users).set({ language }).where(eq(users.id, request.user!.id));
      return reply.code(200).send({ language });
    },
  );

  app.post(
    "/invites",
    {
      preHandler: requireAdmin,
      schema: {
        // slackUserId opzionale: l'invito originato dal picker del workspace
        // porta con sé l'identità Slack, propagata all'utente alla
        // registrazione. L'email resta obbligatoria (il picker la precompila).
        body: z.object({ email: z.email(), slackUserId: z.string().min(1).optional() }),
        response: {
          201: z.object({ token: z.string(), expiresAt: z.iso.datetime() }),
          400: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { email, slackUserId } = request.body;
      // Avatar derivato server-side dal profilo Slack, mai dal client.
      let slackAvatarUrl: string | null = null;
      if (slackUserId) {
        const creds = await loadSlackCreds(instance);
        if (!creds) {
          return apiError(reply, 400, "slack_not_configured", "Slack integration is not configured");
        }
        const client = slackClientFactory(creds.botToken);
        const profile = await client.getUserProfile(slackUserId);
        if (!profile) {
          return apiError(reply, 400, "slack_user_not_found", "Slack user not found");
        }
        slackAvatarUrl = profile.avatarUrl;
      }
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      await app.db
        .insert(invites)
        .values({ token, email, expiresAt, slackUserId: slackUserId ?? null, slackAvatarUrl });
      return reply.code(201).send({ token, expiresAt: expiresAt.toISOString() });
    },
  );

  // Inviti ancora in sospeso: una riga in `invites` esiste solo finché il
  // token non è stato consumato (la register la elimina), quindi la tabella
  // coincide con la lista degli invitati che non si sono ancora registrati.
  // Solo admin: il token permette di registrarsi e non va esposto ai member.
  app.get(
    "/invites",
    {
      preHandler: requireAdmin,
      schema: {
        response: {
          200: z.array(
            z.object({
              token: z.string(),
              email: z.email(),
              expiresAt: z.iso.datetime(),
              createdAt: z.iso.datetime(),
              // Identità Slack dell'invito (null se invito email classico),
              // per mostrare l'avatar nella lista inviti della pagina Team.
              slackUserId: z.string().nullable(),
              slackAvatarUrl: z.string().nullable(),
            }),
          ),
          ...authErrorResponses,
        },
      },
    },
    async () => {
      const rows = await app.db
        .select({
          token: invites.token,
          email: invites.email,
          expiresAt: invites.expiresAt,
          createdAt: invites.createdAt,
          slackUserId: invites.slackUserId,
          slackAvatarUrl: invites.slackAvatarUrl,
        })
        .from(invites)
        .orderBy(desc(invites.createdAt));
      return rows.map((row) => ({
        ...row,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      }));
    },
  );

  // Revoca di un invito in sospeso (solo admin): elimina la riga, rendendo il
  // token inutilizzabile. 404 se il token non esiste (già usato o mai creato).
  app.delete(
    "/invites/:token",
    {
      preHandler: requireAdmin,
      schema: {
        params: z.object({ token: z.string().min(1) }),
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [deleted] = await app.db
        .delete(invites)
        .where(eq(invites.token, request.params.token))
        .returning({ token: invites.token });
      if (!deleted) {
        return apiError(reply, 404, "invite_not_found", "Invite not found");
      }
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/register",
    {
      config: { rateLimit: opts.rateLimit },
      schema: {
        body: credentialsSchema.extend({ token: z.string().min(1) }),
        response: {
          201: authUserResponseSchema,
          409: errorSchema,
          410: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const [invite] = await app.db
        .select()
        .from(invites)
        .where(eq(invites.token, request.body.token));
      // Token sconosciuto e token già consumato sono indistinguibili (la riga
      // non c'è più): stessa risposta 410.
      if (!invite) {
        return apiError(reply, 410, "invite_invalid", "Invite invalid or already used");
      }
      if (invite.expiresAt.getTime() <= Date.now()) {
        await app.db.delete(invites).where(eq(invites.token, invite.token));
        return apiError(reply, 410, "invite_expired", "Invite expired");
      }

      const [existing] = await app.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, request.body.email));
      if (existing) {
        return apiError(reply, 409, "email_already_exists", "A user with this email already exists");
      }

      // Identità Slack dell'invito propagata all'utente. Lo Slack id su `users`
      // è unique: se è già di un altro utente, NON si fa fallire la
      // registrazione: un pre-check (non atomico ma sufficiente — l'admin non
      // emette inviti concorrenti sullo stesso Slack id) omette i campi Slack e
      // crea comunque l'utente, senza identità Slack. È più semplice e robusto
      // del distinguere la unique violation su email da quella su slack_user_id
      // intercettando l'errore.
      let inviteSlackUserId = invite.slackUserId;
      let inviteSlackAvatarUrl = invite.slackAvatarUrl;
      if (inviteSlackUserId) {
        const [slackOwner] = await app.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.slackUserId, inviteSlackUserId));
        if (slackOwner) {
          inviteSlackUserId = null;
          inviteSlackAvatarUrl = null;
        }
      }

      const passwordHash = await hashPassword(request.body.password);
      // Consumo dell'invito e creazione utente in transazione, con il delete
      // PRIMA dell'insert: in concorrenza solo la richiesta il cui delete
      // restituisce la riga prosegue, l'altra riceve 410. Il rollback
      // garantisce che non restino inviti bruciati senza utente.
      let user: typeof users.$inferSelect | null;
      try {
        user = await app.db.transaction(async (tx) => {
          const [consumed] = await tx
            .delete(invites)
            .where(eq(invites.token, invite.token))
            .returning();
          if (!consumed) return null;
          const [created] = await tx
            .insert(users)
            .values({
              email: request.body.email,
              passwordHash,
              role: "member",
              slackUserId: inviteSlackUserId,
              slackAvatarUrl: inviteSlackAvatarUrl,
            })
            .returning();
          if (!created) throw new Error("insert del member non ha restituito la riga");
          return created;
        });
      } catch (error) {
        // Il pre-check sull'email qui sopra non è atomico: in concorrenza il
        // perdente arriva al vincolo unique. La transazione fa rollback,
        // quindi il suo invito resta utilizzabile.
        if (isUniqueViolation(error)) {
          return apiError(reply, 409, "email_already_exists", "A user with this email already exists");
        }
        throw error;
      }
      if (!user) {
        return apiError(reply, 410, "invite_invalid", "Invite invalid or already used");
      }
      return reply
        .code(201)
        .send({ user: { id: user.id, email: user.email, role: user.role } });
    },
  );
}
