import { eq, inArray } from "drizzle-orm";
import { claudeActionGroups, claudeActions, type Db } from "@stubwise/db";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * «via Claude» DERIVATO A LETTURA (chat, fetta 3). Le scritture di Claude per
 * conto di una persona portano `via_claude_action_id` (default di colonna dal
 * setting della transazione); le letture ne derivano il segno, l'azione e CHI
 * L'HA CHIESTA, dal gruppo — mai dal jsonb di una notifica, che resta
 * com'era: così vale anche per le righe scritte prima che il campo esistesse
 * (invariante «i campi che un client legge si derivano a lettura»).
 *
 * `requesterId` nullo con `viaClaude` vero: l'azione esiste ma il gruppo no
 * (non succede con le FK di oggi; il client lo rende come «via Claude» senza
 * nome).
 */
export interface ViaClaudeFields {
  viaClaude: boolean;
  viaClaudeActionId: string | null;
  viaClaudeRequesterId: string | null;
}

export const NOT_VIA_CLAUDE: ViaClaudeFields = {
  viaClaude: false,
  viaClaudeActionId: null,
  viaClaudeRequesterId: null,
};

/**
 * Carica in UNA query il richiedente di ogni azione nominata e restituisce la
 * funzione che dà i campi di una riga dal suo `via_claude_action_id`.
 */
export async function loadViaClaude(
  db: DbOrTx,
  actionIds: readonly (string | null)[],
): Promise<(actionId: string | null) => ViaClaudeFields> {
  const ids = [...new Set(actionIds.filter((id): id is string => id !== null))];
  const requester = new Map<string, string>();
  if (ids.length > 0) {
    const rows = await db
      .select({ id: claudeActions.id, requesterId: claudeActionGroups.requesterId })
      .from(claudeActions)
      .innerJoin(claudeActionGroups, eq(claudeActionGroups.id, claudeActions.groupId))
      .where(inArray(claudeActions.id, ids));
    for (const r of rows) requester.set(r.id, r.requesterId);
  }
  return (actionId) =>
    actionId === null
      ? NOT_VIA_CLAUDE
      : { viaClaude: true, viaClaudeActionId: actionId, viaClaudeRequesterId: requester.get(actionId) ?? null };
}
