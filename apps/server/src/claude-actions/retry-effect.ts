import { claudeActionGroups, claudeActions, mailDrafts, type Db } from "@stubwise/db";
import type { ClaudeActionGroupView } from "@stubwise/shared";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import { mailBodyTarget } from "../services/mail-body-target.js";
import { groupViewOf } from "./proposals.js";

/**
 * Rimandi, lotto 4 (§5): «Riprova» per il seguito di un `fillMailBody` che
 * Gmail non ha salvato (`effect_failure = 'mail_not_saved'`). Il testo è
 * quello salvato negli argomenti dell'azione, mai uno mandato dal client; il
 * bersaglio si riverifica ADESSO (`mailBodyTarget`); nessun invio, mai, e il
 * registro decisioni non si tocca.
 *
 * D-5.2 = b: una bozza della stessa conversazione cambiata DOPO l'azione non
 * si sovrascrive (`draft_changed`): il riprova arriva dopo, e cancellerebbe
 * in silenzio ciò che la persona ha scritto. Il testo resta da copiare.
 * Limite accettato (registro): se nel frattempo la mail è partita, il
 * riprova crea una bozza nuova nel thread.
 */
export type RetryEffectResult =
  | { ok: true; group: ClaudeActionGroupView }
  | { ok: false; status: 404 | 409; code: "not_found" | "not_retryable" | "already_saved" | "mail_not_found" | "mail_forbidden" | "draft_changed" | "mail_not_saved"; reason?: string };

type MailBodyArgs = { accountId: string; threadId: string | null; mode: "new" | "reply" | "replyAll" | "forward"; text: string };

export async function retryActionEffect(
  db: Db,
  user: SessionUser,
  groupId: string,
  index: number,
  fill: (userId: string, args: MailBodyArgs) => Promise<{ error?: string }>,
): Promise<RetryEffectResult> {
  const [group] = await db.select().from(claudeActionGroups).where(eq(claudeActionGroups.id, groupId));
  // Un gruppo d'altri risponde come uno che non c'è (come `undo` con `not_yours`).
  if (!group || group.requesterId !== user.id) return { ok: false, status: 404, code: "not_found" };
  const actions = await db.select().from(claudeActions).where(eq(claudeActions.groupId, group.id)).orderBy(asc(claudeActions.seq));
  const action = actions[index];
  if (!action) return { ok: false, status: 404, code: "not_found" };
  if (action.fn !== "fillMailBody") return { ok: false, status: 409, code: "not_retryable" };
  if (action.effectFailure === null) return { ok: false, status: 409, code: "already_saved" };
  const args = action.args as MailBodyArgs;
  const target = await mailBodyTarget(db, user.id, args);
  if (target !== "ok") return { ok: false, status: 409, code: target === "forbidden" ? "mail_forbidden" : "mail_not_found" };
  const [changed] = await db
    .select({ id: mailDrafts.id })
    .from(mailDrafts)
    .where(
      and(
        eq(mailDrafts.userId, user.id),
        eq(mailDrafts.accountId, args.accountId),
        eq(mailDrafts.mode, args.mode),
        eq(mailDrafts.state, "active"),
        sql`coalesce(${mailDrafts.threadId}, '') = coalesce(${args.threadId}, '')`,
        gt(mailDrafts.updatedAt, group.executedAt),
      ),
    )
    .limit(1);
  if (changed) return { ok: false, status: 409, code: "draft_changed" };
  const out = await fill(user.id, args);
  if (out.error) return out.error === "draft_changed" ? { ok: false, status: 409, code: "draft_changed" } : { ok: false, status: 409, code: "mail_not_saved", reason: out.error };
  // Due riprova insieme scrivono lo stesso testo nella stessa bozza: ne vince uno.
  await db.update(claudeActions).set({ effectFailure: null }).where(and(eq(claudeActions.id, action.id), isNotNull(claudeActions.effectFailure)));
  return { ok: true, group: await groupViewOf(db, user, group, group.sessionId) };
}
