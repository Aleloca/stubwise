import type { FastifyInstance } from "fastify";
import type { GraphMcpClient, QueryGraphParams } from "../graph-chat/client.js";

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
 * Bootstrap standard per i test di route protette: setup dell'admin, login,
 * invito + registrazione di un member, login del member. Restituisce i
 * cookie di sessione (e gli id utente, utili per assegnatari e autori).
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

  const adminLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.com", password: "password-sicura" },
  });
  if (adminLogin.statusCode !== 200) {
    throw new Error(`login admin fallito: ${adminLogin.statusCode} ${adminLogin.body}`);
  }
  const adminCookie = sessionCookie(adminLogin);

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

  const memberLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "member@example.com", password: "password-member" },
  });
  if (memberLogin.statusCode !== 200) {
    throw new Error(`login member fallito: ${memberLogin.statusCode} ${memberLogin.body}`);
  }
  const memberCookie = sessionCookie(memberLogin);

  return { adminCookie, memberCookie, adminId, memberId };
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
