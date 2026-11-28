import { appUrl } from "@stubwise/shared/app-links";
import { repositoryDocsAppUrl } from "./app-link-targets.js";
import type { DbOrTx } from "./dispatch.js";
import type { DocsNightlyAttentionEvent } from "./format.js";
import { publishNotification, type PublishOpts } from "./publish.js";

/** Cosa sa chi pubblica: l'evento senza `kind` e senza URL, più la base pubblica. */
export type DocsNightlyAttentionInput = Omit<DocsNightlyAttentionEvent, "kind" | "docsUrl"> & {
  /** Base pubblica dell'istanza (`PUBLIC_URL`); il link porta ai Docs del repository nella nuova app. */
  publicUrl: string;
};

/**
 * Costruisce l'evento `docs.nightly_attention`. Il `docsUrl` lo deriva
 * {@link publishDocsNightlyAttention} dal DB (`repositoryDocsAppUrl`: lo slug
 * del repository nel suo progetto), mai chi pubblica.
 */
export function buildDocsNightlyAttentionEvent(
  input: DocsNightlyAttentionInput,
  docsUrl: string,
): DocsNightlyAttentionEvent {
  const { publicUrl: _publicUrl, ...rest } = input;
  void _publicUrl;
  return { kind: "docs.nightly_attention", ...rest, docsUrl };
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
    // Un repository che non si legge non toglie l'avviso: si ripiega sulla Home.
    const docsUrl = await repositoryDocsAppUrl(db, input.publicUrl, input.repositoryId).catch(() => appUrl(input.publicUrl, { to: "home" }));
    await publish(db, buildDocsNightlyAttentionEvent(input, docsUrl), opts);
  } catch {
    // Best-effort.
  }
}
