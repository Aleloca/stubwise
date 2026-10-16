import type { DbOrTx } from "./dispatch.js";
import type { DocsNightlyAttentionEvent } from "./format.js";
import { publishNotification, type PublishOpts } from "./publish.js";

/** Cosa sa chi pubblica: l'evento senza `kind` e senza URL, più la base pubblica. */
export type DocsNightlyAttentionInput = Omit<DocsNightlyAttentionEvent, "kind" | "docsUrl"> & {
  /** Base pubblica dell'istanza (`PUBLIC_URL`); il link porta a `/docs/:repositoryId`. */
  publicUrl: string;
};

/** Costruisce l'evento `docs.nightly_attention` (il `docsUrl` è derivato, mai passato a mano). */
export function buildDocsNightlyAttentionEvent(
  input: DocsNightlyAttentionInput,
): DocsNightlyAttentionEvent {
  const { publicUrl, ...rest } = input;
  const base = publicUrl.replace(/\/+$/, "");
  return {
    kind: "docs.nightly_attention",
    ...rest,
    docsUrl: `${base}/docs/${input.repositoryId}`,
  };
}

/**
 * Pubblica l'avviso del giro notturno ai soli admin (routing `admins`), sotto
 * l'interruttore `notifyDocsLimitPaused`. Come `publishNotification` non lancia
 * mai: un avviso mancato non deve alterare il giro. L'unica ancora è il
 * progetto (nessun ticket né job dietro un repository). Lo usano l'allarme del
 * piano (`plan_oversized`) e l'escalation di un elemento (`item_failing`).
 */
export async function publishDocsNightlyAttention(
  db: DbOrTx,
  input: DocsNightlyAttentionInput,
  deps: { publish?: typeof publishNotification } = {},
): Promise<void> {
  const publish = deps.publish ?? publishNotification;
  const opts: PublishOpts = { projectId: input.projectId };
  try {
    await publish(db, buildDocsNightlyAttentionEvent(input), opts);
  } catch {
    // Best-effort.
  }
}
