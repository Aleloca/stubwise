import { eq } from "drizzle-orm";
import { personalAccessTokens, projectMembers, roles, users } from "@stubwise/db";
import {
  effectiveInstancePermissions,
  PRESET_ROLES,
  type InstancePermission,
} from "@stubwise/shared";
import { BitbucketProvider, GitHubProvider } from "@stubwise/git";
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";
import type { GraphMcpClient, QueryGraphParams } from "../graph-chat/client.js";
import { generatePat, hashServerKey } from "../routes/shared.js";
import {
  createSession,
  PARTIAL_SESSION_TTL_MS,
  SESSION_COOKIE,
  type SessionStage,
} from "../auth/session.js";

/** Cookie e identità prodotti da {@link seedUsers}, pronti per `app.inject`. */
export interface SeededUsers {
  adminCookie: string;
  memberCookie: string;
  adminId: string;
  memberId: string;
}

/**
 * Estrae il cookie di sessione da una risposta di `app.inject`, già nel
 * formato `nome=valore` da passare nell'header `cookie`.
 */
export function sessionCookie(res: { cookies: { name: string; value: string }[] }): string {
  const cookie = res.cookies.find((c) => c.name === "stubwise_session");
  if (!cookie) throw new Error("cookie stubwise_session assente nella risposta");
  return `stubwise_session=${cookie.value}`;
}

/**
 * L'header `cookie` di una sessione `id`, firmato e codificato come lo manda
 * `/login` (`setCookie(..., { signed: true })`).
 */
async function signedSessionCookie(app: FastifyInstance, id: string): Promise<string> {
  // `signCookie` lo decora @fastify/cookie, che si carica al `ready`: su
  // un'app appena costruita, prima di ogni `inject`, ancora non c'è.
  await app.ready();
  return `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(id))}`;
}

/**
 * Cookie di una sessione COMPLETA per `userId`, creata direttamente (senza
 * passare da `/login`) e col secondo fattore appena fatto: è la sessione di
 * chi ha finito il login, e apre ogni rotta (anche quelle che chiedono una
 * riconferma recente).
 */
export async function fullSessionCookie(app: FastifyInstance, userId: string): Promise<string> {
  const session = await createSession(app.db, userId, {
    stage: "full",
    secondFactorAt: new Date(),
  });
  return signedSessionCookie(app, session.id);
}

/**
 * Cookie di una sessione PARZIALE per `userId` (login a metà: password giusta,
 * secondo fattore ancora da fare o da configurare), con la durata breve vera.
 */
export async function partialSessionCookie(
  app: FastifyInstance,
  userId: string,
  stage: Exclude<SessionStage, "full">,
): Promise<string> {
  const session = await createSession(app.db, userId, { stage, ttlMs: PARTIAL_SESSION_TTL_MS });
  return signedSessionCookie(app, session.id);
}

/**
 * Bootstrap standard per i test di route protette: setup dell'admin, invito +
 * registrazione di un member, e una sessione completa per ciascuno. Restituisce
 * i cookie di sessione (e gli id utente, utili per assegnatari e autori).
 * Le sessioni NON passano da `/login`: il login a due passi chiede un secondo
 * fattore, e una suite che non parla di login non deve dipenderne.
 * Da chiamare una volta per file di test, in `beforeAll`, su un'app appena
 * costruita con un DB vuoto.
 */
export async function seedUsers(app: FastifyInstance): Promise<SeededUsers> {
  const setup = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    payload: { email: "admin@example.com", password: "password-sicura" },
  });
  if (setup.statusCode !== 201) {
    throw new Error(`setup admin fallito: ${setup.statusCode} ${setup.body}`);
  }
  const adminId = (setup.json() as { user: { id: string } }).user.id;
  const adminCookie = await fullSessionCookie(app, adminId);

  const invite = await app.inject({
    method: "POST",
    url: "/api/auth/invites",
    headers: { cookie: adminCookie },
    payload: { email: "member@example.com" },
  });
  if (invite.statusCode !== 201) {
    throw new Error(`invito fallito: ${invite.statusCode} ${invite.body}`);
  }
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      token: (invite.json() as { token: string }).token,
      email: "member@example.com",
      password: "password-member",
    },
  });
  if (register.statusCode !== 201) {
    throw new Error(`register member fallito: ${register.statusCode} ${register.body}`);
  }
  const memberId = (register.json() as { user: { id: string } }).user.id;
  const memberCookie = await fullSessionCookie(app, memberId);

  return { adminCookie, memberCookie, adminId, memberId };
}

/** Id del ruolo preset con quella `preset_key` (es. `legacy_member`, `developer`). */
export async function presetRoleId(app: FastifyInstance, presetKey: string): Promise<string> {
  const [row] = await app.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.presetKey, presetKey));
  if (!row) throw new Error(`ruolo preset ${presetKey} assente`);
  return row.id;
}

/**
 * Rende `userId` membro di `projectId` col ruolo preset `presetKey` (default
 * `legacy_member`: quello che un `member` ha su ogni progetto dopo la
 * conversione). Serve ai test: un utente creato DOPO la migrazione non è
 * membro di nulla, e un progetto non visibile risponde 404. Idempotente sul
 * ruolo: una seconda chiamata lo sostituisce.
 */
export async function addMember(
  app: FastifyInstance,
  projectId: string,
  userId: string,
  presetKey = "legacy_member",
): Promise<void> {
  const roleId = await presetRoleId(app, presetKey);
  await app.db
    .insert(projectMembers)
    .values({ projectId, userId, roleId })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { roleId },
    });
}

/**
 * Un utente d'istanza `User` (nessun progetto) con un PAT, creato nel DB:
 * restituisce l'id e l'header `authorization` per `app.inject`. Per i test a
 * più ruoli di progetto: gli si dà poi un ruolo con {@link addMember}.
 */
export async function createUserWithPat(
  app: FastifyInstance,
  email: string,
): Promise<{ id: string; headers: { authorization: string } }> {
  const [row] = await app.db
    .insert(users)
    .values({ email, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  const token = generatePat();
  await app.db
    .insert(personalAccessTokens)
    .values({ userId: row!.id, name: "test", tokenHash: hashServerKey(token) });
  return { id: row!.id, headers: { authorization: `Bearer ${token}` } };
}

/**
 * Un attore «di sessione» per chiamare i servizi direttamente: id, ruolo
 * derivato e i permessi d'istanza dei preset `Admin` (full admin) o `User`,
 * come li risolverebbe il server dal ruolo d'istanza.
 */
export function actorAs(
  id: string,
  role: "admin" | "member",
): { id: string; role: "admin" | "member"; instancePermissions: ReadonlySet<InstancePermission> } {
  const preset = PRESET_ROLES.find((r) => r.key === (role === "admin" ? "admin" : "user"))!;
  return { id, role, instancePermissions: effectiveInstancePermissions(preset.permissions) };
}

/** Client MCP finto verso graphify: registra le query e risponde a comando. */
export interface FakeGraphMcpClient extends GraphMcpClient {
  /** Query ricevute, in ordine: per asserire domanda e `project_path`. */
  calls: QueryGraphParams[];
  /** Sottografo restituito dalla PROSSIMA query; `null` = nessun contesto utile. */
  response: string | null;
  /** Azzera chiamate e risposta (da chiamare nel `beforeEach`). */
  reset(): void;
}

/**
 * Fake del client MCP del retrieval dal grafo (fase 2b), da iniettare in
 * `buildApp({ graphMcpClient })`: nessuna rete, nessun container graphify.
 *
 * Di default risponde `null` (= grafo senza nulla di utile), così i test che non
 * si occupano del grafo restano esattamente com'erano; chi vuole il blocco nel
 * prompt imposta `fake.response = "<sottografo finto>"`. `calls` serve anche ai
 * test NEGATIVI (widget): deve restare vuoto.
 */
export function createFakeGraphMcpClient(): FakeGraphMcpClient {
  const fake: FakeGraphMcpClient = {
    calls: [],
    response: null,
    async queryGraph(params: QueryGraphParams): Promise<string | null> {
      fake.calls.push(params);
      return fake.response;
    },
    close: async (): Promise<void> => undefined,
    reset(): void {
      fake.calls = [];
      fake.response = null;
    },
  };
  return fake;
}

/**
 * Esegue `fn` con l'identità sulla piattaforma SENZA rete. Ogni salvataggio
 * di una repository (`POST`/`PATCH /api/repositories`) verifica l'identità
 * dell'account principale per l'avviso `main_account_identity_unresolved`
 * (ciclo di correzione, D7): nei test che creano una repository solo come
 * contorno, senza un doppio, quella verifica chiamerebbe GitHub/Bitbucket per
 * davvero. Il doppio RIGETTA — l'avviso compare, nessuna identità finisce in
 * cache — e si installa solo se il test non ne ha già uno suo; finito `fn`
 * si toglie, così non inquina il conteggio delle chiamate dei doppi che il
 * test installa DOPO (es. «il provider non va interrogato»).
 */
export async function withOfflinePlatformIdentity<T>(fn: () => Promise<T>): Promise<T> {
  const installed = [GitHubProvider, BitbucketProvider]
    .filter((provider) => !vi.isMockFunction(provider.prototype.getAuthenticatedUserId))
    .map((provider) =>
      vi
        .spyOn(provider.prototype, "getAuthenticatedUserId")
        .mockRejectedValue(new Error("identità sulla piattaforma: rete spenta nei test")),
    );
  try {
    return await fn();
  } finally {
    for (const spy of installed) spy.mockRestore();
  }
}
