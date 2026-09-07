import { googleAccounts, googleWorkspaces } from "@stubwise/db";
import { revokeToken, type FetchImpl } from "@stubwise/google";
import { loadGoogleAccountCredentials } from "@stubwise/google/credentials";
import {
  GOOGLE_ACCOUNT_SETTINGS_PATH,
  GOOGLE_OAUTH_CALLBACK_PATH,
  googleAccountPatchSchema,
  googleAccountSchema,
  googleConnectBodySchema,
  googleConnectResponseSchema,
  googleWorkspaceOptionSchema,
  type GoogleCallbackOutcome,
} from "@stubwise/shared";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { beginConnect, completeCallback, type GoogleOauthDeps } from "../services/google-oauth.js";
import { authErrorResponses, errorSchema, type RateLimitConfig } from "./shared.js";

/**
 * CASELLE GOOGLE DELL'UTENTE (Fase 6, Task 5), sotto `/api/me/google`.
 *
 * Il soggetto è sempre "io", come per il resto di `/api/me`: **`user_id` è nel
 * WHERE di ogni rotta che tocca una casella**, e una riga altrui risponde 404 e
 * non 403 — un 403 confermerebbe che quell'id esiste, e l'id di una casella non
 * è un'informazione che chi non la possiede debba poter distinguere da un id
 * inventato. Non c'è un ruolo che scavalchi il filtro: nemmeno un admin vede o
 * scollega la casella di un altro, perché la posta di una persona non è un dato
 * amministrabile.
 *
 * ⚠️ `GET /callback` è l'ECCEZIONE, e l'unica: non ha `requireAuth`, perché ci
 * arriva un browser che torna da `accounts.google.com` senza garanzia di
 * cookie (design §3, «Nessun cookie richiesto»). L'identità dell'utente la
 * porta lo `state` firmato — vedi il docblock di `services/google-oauth.ts`, che
 * è dove sta il ragionamento sulla sicurezza di questo flusso. Per la stessa
 * ragione la rotta è a **rate limit come il login**: è la sola superficie di
 * `/api/me` che uno sconosciuto può colpire.
 *
 * ⚠️ Il callback risponde con un **redirect**, mai con un JSON d'errore: lo
 * legge un utente in un browser, non un client. L'unico 400 è per lo `state`
 * non verificabile, che non è la conclusione di un flusso nostro.
 */

export interface MeGoogleRoutesOptions {
  /**
   * Tetto per IP del solo callback (stesso preset del login). Il resto delle
   * rotte è autenticato e non ne ha bisogno.
   */
  rateLimit: RateLimitConfig;
  /**
   * `fetch` verso Google. Default: quello globale. Override nei test, che non
   * devono toccare la rete.
   */
  fetchImpl?: FetchImpl;
}

const idParamsSchema = z.object({ id: z.uuid() });

/** Query del callback: Google manda `code`+`state`, o `error` se l'utente rifiuta. */
const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

/** Le colonne della proiezione pubblica: il refresh token non è fra queste. */
const accountColumns = {
  id: googleAccounts.id,
  email: googleAccounts.email,
  workspaceId: googleAccounts.workspaceId,
  workspaceName: googleWorkspaces.name,
  scopes: googleAccounts.scopes,
  proposalsEnabled: googleAccounts.proposalsEnabled,
  connectedAt: googleAccounts.connectedAt,
  lastSyncAt: googleAccounts.lastSyncAt,
  disabledAt: googleAccounts.disabledAt,
  disabledReason: googleAccounts.disabledReason,
};

/** La riga che la select qui sopra produce (nullability delle colonne inclusa). */
interface AccountRow {
  id: string;
  email: string;
  workspaceId: string;
  workspaceName: string;
  scopes: string[];
  proposalsEnabled: boolean;
  connectedAt: Date;
  lastSyncAt: Date | null;
  disabledAt: Date | null;
  disabledReason: string | null;
}

/**
 * Proiezione pubblica, costruita campo per campo e MAI con uno spread della
 * riga: è la stessa difesa del `client_secret` del registro Workspace. Uno
 * spread farebbe uscire `refresh_token_encrypted` il giorno in cui qualcuno
 * cambiasse la select in un `select()` nudo.
 */
function toPublicAccount(row: AccountRow): z.infer<typeof googleAccountSchema> {
  return {
    id: row.id,
    email: row.email,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    scopes: row.scopes,
    proposalsEnabled: row.proposalsEnabled,
    connectedAt: row.connectedAt.toISOString(),
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    disabledReason: row.disabledReason,
  };
}

export async function meGoogleRoutes(
  instance: FastifyInstance,
  opts: MeGoogleRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  const deps = (): GoogleOauthDeps => ({
    db: app.db,
    encryptionKey: app.encryptionKey,
    // L'URI di redirect è UNO per istanza e deve combaciare CARATTERE PER
    // CARATTERE con quello registrato in Google Cloud Console (Google confronta
    // la stringa, non l'URL normalizzato) — ed è lo stesso che il registro
    // Workspace mostra all'admin da incollare. Una sola espressione, in due
    // punti: qui e in `google-workspaces.ts`.
    redirectUri: `${app.publicUrl}${GOOGLE_OAUTH_CALLBACK_PATH}`,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  /** Redirect alla pagina Account con l'esito nel query param. */
  function redirectWithOutcome(reply: FastifyReply, outcome: GoogleCallbackOutcome) {
    // Path RELATIVO e non `publicUrl` + path: la SPA è servita da caddy sullo
    // stesso origin dell'API, e un Location relativo la raggiunge comunque —
    // mentre `publicUrl` mal configurato manderebbe l'utente su un host
    // sbagliato proprio nel momento in cui il collegamento è appena riuscito.
    return reply.redirect(`${GOOGLE_ACCOUNT_SETTINGS_PATH}?google=${outcome}`, 302);
  }

  /**
   * I Workspace fra cui scegliere, per QUALUNQUE utente autenticato.
   *
   * ⚠️ Non è un doppione di `GET /api/settings/google-workspaces`, che è **solo
   * admin**: un operatore deve poter collegare la propria casella senza essere
   * amministratore dell'istanza, e quella rotta non gliela farebbe nemmeno
   * elencare. Allargarne i permessi sarebbe stato il cambio più piccolo e
   * quello sbagliato — porta `clientId` e `redirectUri`, cioè configurazione
   * dell'istanza, a chi deve solo scegliere una voce da una select.
   */
  app.get(
    "/workspaces",
    {
      preHandler: requireAuth,
      schema: { response: { 200: z.array(googleWorkspaceOptionSchema), ...authErrorResponses } },
    },
    async () => {
      const rows = await app.db
        .select({
          id: googleWorkspaces.id,
          name: googleWorkspaces.name,
          domains: googleWorkspaces.domains,
          clientSecretEncrypted: googleWorkspaces.clientSecretEncrypted,
        })
        .from(googleWorkspaces)
        .orderBy(asc(googleWorkspaces.name));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        domains: row.domains,
        // La stessa sentinella del registro: `""` = nessun segreto configurato.
        clientSecretSet: row.clientSecretEncrypted !== "",
      }));
    },
  );

  /**
   * Avvia il collegamento. Risponde con la URL di consenso invece di
   * reindirizzare: la chiamata parte da `fetch` nella SPA, e un 302 verrebbe
   * seguito dal browser in background — cioè in nessun posto visibile.
   */
  app.post(
    "/connect",
    {
      preHandler: requireAuth,
      schema: {
        body: googleConnectBodySchema,
        response: {
          200: googleConnectResponseSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await beginConnect(deps(), {
        userId: request.user!.id,
        workspaceId: request.body.workspaceId,
      });
      if (result.status === "workspace_not_found") {
        return apiError(reply, 404, "google_workspace_not_found", "Google Workspace not found");
      }
      if (result.status === "workspace_secret_missing") {
        return apiError(
          reply,
          409,
          "workspace_secret_missing",
          "Google Workspace has no client secret configured",
        );
      }
      return { authorizeUrl: result.authorizeUrl };
    },
  );

  /**
   * Ritorno da Google. Senza autenticazione e con il rate limit del login: vedi
   * il docblock in testa al file.
   */
  app.get(
    "/callback",
    {
      config: { rateLimit: opts.rateLimit },
      schema: {
        querystring: callbackQuerySchema,
        response: { 302: z.null(), 400: errorSchema },
      },
    },
    async (request, reply) => {
      const { code, state, error } = request.query;
      // L'utente ha premuto "Annulla" sulla schermata di consenso: non è un
      // errore nostro, ma non c'è nulla da collegare.
      if (error) {
        request.log.info({ error }, "consenso Google rifiutato dall'utente");
        return redirectWithOutcome(reply, "error");
      }
      if (!code || !state) {
        return apiError(reply, 400, "invalid_callback", "Missing code or state");
      }

      const result = await completeCallback(deps(), { code, state });
      if (result.status === "invalid_state") {
        // 400 e non redirect: uno state non nostro, riusato o scaduto non è la
        // conclusione di un flusso che abbiamo avviato noi.
        request.log.warn({ detail: result.detail }, "state OAuth Google non valido");
        return apiError(reply, 400, "invalid_state", "Invalid or expired OAuth state");
      }
      if (result.status !== "ok") {
        request.log.warn(
          { outcome: result.status, detail: result.detail },
          "collegamento della casella Google rifiutato",
        );
      }
      return redirectWithOutcome(reply, result.status);
    },
  );

  /** Le MIE caselle. */
  app.get(
    "/accounts",
    {
      preHandler: requireAuth,
      schema: { response: { 200: z.array(googleAccountSchema), ...authErrorResponses } },
    },
    async (request) => {
      const rows = await app.db
        .select(accountColumns)
        .from(googleAccounts)
        .innerJoin(googleWorkspaces, eq(googleWorkspaces.id, googleAccounts.workspaceId))
        .where(eq(googleAccounts.userId, request.user!.id))
        .orderBy(asc(googleAccounts.connectedAt));
      return rows.map(toPublicAccount);
    },
  );

  /**
   * L'unica cosa modificabile: il toggle delle proposte. Non c'è un modo di
   * cambiare Workspace o email — quelli li decide un consenso nuovo.
   */
  app.patch(
    "/accounts/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: googleAccountPatchSchema,
        response: { 200: googleAccountSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [updated] = await app.db
        .update(googleAccounts)
        .set({ proposalsEnabled: request.body.proposalsEnabled })
        // `userId` nel WHERE: senza, chiunque potrebbe spegnere le proposte di
        // una casella altrui conoscendone l'id.
        .where(
          and(eq(googleAccounts.id, request.params.id), eq(googleAccounts.userId, request.user!.id)),
        )
        .returning({ id: googleAccounts.id });
      if (!updated) {
        return apiError(reply, 404, "google_account_not_found", "Google account not found");
      }
      const [row] = await app.db
        .select(accountColumns)
        .from(googleAccounts)
        .innerJoin(googleWorkspaces, eq(googleWorkspaces.id, googleAccounts.workspaceId))
        .where(eq(googleAccounts.id, updated.id));
      if (!row) {
        return apiError(reply, 404, "google_account_not_found", "Google account not found");
      }
      return toPublicAccount(row);
    },
  );

  /**
   * Scollega: REVOCA su Google e poi cancella la riga.
   *
   * La revoca è **best-effort** (design §3) e per una ragione precisa: se
   * fallisse la richiesta, l'utente resterebbe con una casella che non riesce a
   * togliere — cioè il contrario di ciò che ha chiesto — mentre il fallimento
   * più probabile è che il consenso su Google sia GIÀ stato revocato da lì.
   * Quindi si logga e si prosegue. Il costo del caso peggiore (rete giù) è un
   * grant che resta appeso nell'account Google dell'utente, revocabile a mano
   * da myaccount.google.com; il costo dell'alternativa sarebbe una casella non
   * scollegabile.
   *
   * La revoca va comunque PRIMA della delete: dopo, il refresh token non
   * esisterebbe più da nessuna parte e il grant resterebbe appeso per sempre.
   *
   * ⚠️ Quello che se ne va con la riga: `email_messages` e `calendar_events`
   * hanno la FK su `account_id` **ON DELETE CASCADE** (migrazione 0069), quindi
   * la posta ingerita da quella casella sparisce con lei. Le **proposte già
   * prodotte** invece restano (design §3): vivono in `notifications`, che non ha
   * FK verso la casella — la traccia di una decisione già presa non si cancella
   * perché si scollega una casella.
   */
  app.delete(
    "/accounts/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select({ id: googleAccounts.id })
        .from(googleAccounts)
        .where(
          and(eq(googleAccounts.id, request.params.id), eq(googleAccounts.userId, request.user!.id)),
        );
      if (!row) {
        return apiError(reply, 404, "google_account_not_found", "Google account not found");
      }

      const credentials = await loadGoogleAccountCredentials(app.db, app.encryptionKey, row.id);
      if (credentials) {
        try {
          await revokeToken(
            { token: credentials.refreshToken },
            opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {},
          );
        } catch (error) {
          request.log.warn(
            { err: error, accountId: row.id },
            "revoca del token Google fallita: la casella viene scollegata comunque",
          );
        }
      }

      await app.db.delete(googleAccounts).where(eq(googleAccounts.id, row.id));
      return reply.code(204).send(null);
    },
  );
}
