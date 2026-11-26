import type { ToolContext } from "./types.js";

/**
 * L'assegnatario in parole (lotto 2 della parità): `me`, `none`, un id, un'email
 * o un nome fra le persone che il token vede, compreso l'utente di sistema
 * «Claude». Lo usano `update_task` e `create_ticket`. Assegnare Claude avvia il
 * lavoro (`runs.start`, gate del piano, budget): chi chiama lo dice.
 */
export type ResolvedAssignee =
  | { ok: true; id: string | null; label: string; claude: boolean }
  | { ok: false; problem: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = (s: string) => s.trim().toLocaleLowerCase();

/** La riga da aggiungere quando si assegna Claude. */
export const CLAUDE_ASSIGNED_LINE =
  "Assegnata a Claude: questo avvia il lavoro come run_ticket (piano, gate di approvazione, budget).";

export async function resolveAssignee(ctx: ToolContext, raw: string): Promise<ResolvedAssignee> {
  const who = raw.trim();
  if (norm(who) === "none") return { ok: true, id: null, label: "nessuno", claude: false };
  if (norm(who) === "me") {
    const me = await ctx.client.getMe();
    return { ok: true, id: me.id, label: `tu (${me.email})`, claude: false };
  }
  const people = (await ctx.client.listPeople()).filter((p) => !p.deactivated);
  // Anche per id si guarda fra le persone: un id di «Claude» avvia il lavoro come il nome.
  if (UUID_RE.test(who)) {
    const p = people.find((x) => x.id.toLowerCase() === who.toLowerCase());
    return { ok: true, id: who, label: p?.name ?? who, claude: p?.isClaude === true };
  }
  const byEmail = people.filter((p) => norm(p.email) === norm(who));
  const matches =
    byEmail.length > 0
      ? byEmail
      : people.filter((p) => norm(p.name) === norm(who) || norm(p.name).split(/\s+/).includes(norm(who)));
  if (matches.length === 1) {
    const p = matches[0]!;
    return { ok: true, id: p.id, label: p.name, claude: p.isClaude === true };
  }
  if (matches.length === 0) return { ok: false, problem: `nessuna persona «${who}» fra quelle che vedi` };
  return { ok: false, problem: `«${who}» è ambiguo: ${matches.map((p) => `${p.name} <${p.email}>`).join(", ")}` };
}
