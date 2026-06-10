import type { FastifyInstance } from "fastify";

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
