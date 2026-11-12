import { AsyncLocalStorage } from "node:async_hooks";

/**
 * I SEGUITI fuori dalla transazione delle azioni di Claude (chat, fetta 3).
 *
 * L'esecutore gira ogni gruppo in UNA transazione, e la classe la calcola con
 * una PROVA A SECCO: lo stesso giro, poi ROLLBACK. La prova è sicura solo se
 * niente esce dalla transazione — niente HTTP, storage, AI, embedding,
 * risvegli o seguiti dopo il commit. Questo modulo è l'UNICO punto da cui un
 * seguito può passare, ed è lui a conoscere la prova a secco:
 *
 * - `afterCommit(fn)`: il seguito di un'azione (oggi: togliere dallo storage
 *   i file degli allegati di una task o di un commento eliminati). Dentro una
 *   prova a secco si SCARTA; in un'esecuzione vera si accoda e l'esecutore lo
 *   lancia DOPO il commit, best-effort. Fuori da un'esecuzione lancia: un
 *   seguito non registrato altrove non si perde in silenzio.
 * - `assertNotDryRun(what)`: per qualunque chiamata esterna che un domani una
 *   voce del catalogo facesse (HTTP, AI…): in una prova a secco FALLISCE, e
 *   la proposta è rifiutata invece di uscire.
 *
 * Il test sul sorgente (`claude-actions-effects.test.ts`) vincola i moduli
 * raggiungibili dal catalogo a non uscire da soli: o niente, o di qui.
 */

/** Ciò che un seguito può usare: lo storage degli allegati (lo dà la rotta). */
export interface ActionEffects {
  storage?: () => Promise<{ deleteObject(key: string): Promise<void> } | null>;
  /** L'URL pubblico dell'istanza: il link delle notifiche che un'azione pubblica (il piano da approvare). */
  publicUrl?: string;
  log?: (message: string, error?: unknown) => void;
  /**
   * Il corpo di un'email nella bozza Gmail di chi ha confermato (`fillMailBody`,
   * area 6, F3). La dà la rotta: il catalogo non conosce il client di Gmail.
   * Lancia se il salvataggio non riesce.
   */
  /** Registra sull'azione che il suo seguito non è riuscito (la scheda lo mostra). */
  markEffectFailure?: (actionId: string, code: string) => Promise<void>;
  mailBody?: (userId: string, args: { accountId: string; threadId: string | null; mode: "new" | "reply" | "replyAll" | "forward"; text: string }) => Promise<void>;
}

type FollowUp = (effects: ActionEffects) => Promise<void>;

interface Context {
  dryRun: boolean;
  followUps: FollowUp[];
}

const context = new AsyncLocalStorage<Context>();

export class DryRunEscapeError extends Error {
  constructor(what: string) {
    super(`dry run: ${what} would leave the transaction`);
    this.name = "DryRunEscapeError";
  }
}

/** Il giro dell'esecutore, con la sua coda di seguiti. */
export async function runActionContext<T>(
  opts: { dryRun: boolean },
  fn: () => Promise<T>,
): Promise<{ value: T; followUps: FollowUp[] }> {
  const ctx: Context = { dryRun: opts.dryRun, followUps: [] };
  const value = await context.run(ctx, fn);
  return { value, followUps: ctx.dryRun ? [] : ctx.followUps };
}

/** Vero dentro una prova a secco dell'esecutore. */
export function inDryRun(): boolean {
  return context.getStore()?.dryRun === true;
}

/** Un seguito dopo il commit: scartato a secco, accodato dal vero. */
export function afterCommit(followUp: FollowUp): void {
  const ctx = context.getStore();
  if (!ctx) throw new Error("afterCommit fuori dall'esecutore delle azioni di Claude");
  if (ctx.dryRun) return;
  ctx.followUps.push(followUp);
}

/** Una chiamata esterna: vietata in una prova a secco. */
export function assertNotDryRun(what: string): void {
  if (inDryRun()) throw new DryRunEscapeError(what);
}

/** I seguiti di un'esecuzione vera, DOPO il commit: best-effort, uno non ferma gli altri. */
export async function runFollowUps(followUps: readonly FollowUp[], effects: ActionEffects): Promise<void> {
  for (const followUp of followUps) {
    try {
      await followUp(effects);
    } catch (error) {
      effects.log?.("seguito di un'azione di Claude fallito", error);
    }
  }
}

/** Il seguito di un'eliminazione: i file degli allegati fuori dallo storage. */
export function deleteStoredObjects(keys: readonly string[]): void {
  if (keys.length === 0) return;
  afterCommit(async (effects) => {
    const storage = effects.storage ? await effects.storage() : null;
    if (!storage) return;
    for (const key of keys) {
      try {
        await storage.deleteObject(key);
      } catch (error) {
        effects.log?.("allegato non rimosso dallo storage", error);
      }
    }
  });
}

/** Il seguito di `fillMailBody`: la bozza su Gmail, DOPO il commit e solo dal vero. */
export function saveMailBody(
  userId: string,
  args: { accountId: string; threadId: string | null; mode: "new" | "reply" | "replyAll" | "forward"; text: string },
  actionId: string | null,
): void {
  afterCommit(async (effects) => {
    try {
      if (!effects.mailBody) throw new Error("fillMailBody senza il salvataggio delle bozze");
      await effects.mailBody(userId, args);
    } catch (error) {
      // L'esito deve dire la verità: il testo NON è nella bozza di Gmail.
      if (actionId && effects.markEffectFailure) await effects.markEffectFailure(actionId, "mail_not_saved");
      throw error;
    }
  });
}

