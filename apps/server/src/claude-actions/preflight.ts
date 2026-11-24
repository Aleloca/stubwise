import { gitAccounts, type Db } from "@stubwise/db";
import type { ClaudeActionFn } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import { verifyDefaultReviewer } from "../services/default-reviewer-verify.js";
import type { CatalogRefusal } from "./catalog.js";

/**
 * LA SECONDA USCITA SANZIONATA del catalogo di Claude (lotto 6, voce 1;
 * decisione di 46, 24 nov 2026; `docs/invariants/agent-sessions.md`). La
 * prima è `effects.ts`: dopo il commit, mai a secco. Questa è l'UNICA prima
 * del commit, e ha regole sue:
 * - SOLO LETTURA: verifica e legge (sul provider, in DB), non scrive niente,
 *   né in DB né sulla piattaforma (un test sul sorgente vieta gli import dei
 *   moduli di scrittura);
 * - gira SOLO al run vero, mai nella prova a secco, una volta per azione,
 *   PRIMA della transazione (`executeGroup`) e solo se chi chiede ha il
 *   permesso della voce;
 * - fail-closed, con un tempo massimo: un errore, un timeout o un'eccezione
 *   sono un rifiuto col suo codice;
 * - ciò che legge passa a `run` (`start.prepared`), che rifà comunque le
 *   guardie di DB: se fra qui e la scrittura cambia qualcosa, la scrittura
 *   rifiuta.
 * Una voce nuova qui è un'eccezione all'invariante del catalogo: va scritta
 * nell'invariante col suo perché.
 */

export interface PreflightDeps {
  encryptionKey?: Buffer;
  /** I test: un tempo massimo più corto. */
  timeoutMs?: number;
  /** Lo mette `runPreflight`: scatta allo scadere del tempo, e ferma le chiamate. */
  signal?: AbortSignal;
}

export type PreflightResult = { ok: true; prepared: unknown } | { ok: false; refusal: CatalogRefusal };
type Preflight = (db: Db, user: SessionUser, args: Record<string, unknown>, deps: PreflightDeps) => Promise<PreflightResult>;

const refused = (code: CatalogRefusal["code"], message: string): PreflightResult => ({ ok: false, refusal: { code, message } });

/** Ciò che `setDefaultReviewer` porta da qui alla scrittura: la riga verificata e l'identità letta. */
export interface DefaultReviewerPrepared {
  row: typeof gitAccounts.$inferSelect;
  providerUserId: string;
}

const PREFLIGHTS: Partial<Record<ClaudeActionFn, Preflight>> = {
  // Il revisore predefinito: la verifica del token sul provider (account,
  // scope, identità) che la rotta fa prima della sua transazione. Solo per
  // `on: true`; togliere il predefinito non verifica niente.
  async setDefaultReviewer(db, _user, args, deps) {
    if (args["on"] !== true) return { ok: true, prepared: null };
    if (!deps.encryptionKey) return refused("other", "preflight_unavailable");
    const [row] = await db.select().from(gitAccounts).where(eq(gitAccounts.id, args["id"] as string));
    if (!row) return refused("not_found", "git_account_not_found");
    const check = await verifyDefaultReviewer(row, deps.encryptionKey, deps.signal ? { signal: deps.signal } : {});
    if (!check.ok) return refused(check.status === 400 ? "invalid" : "conflict", check.code);
    return { ok: true, prepared: { row, providerUserId: check.providerUserId } satisfies DefaultReviewerPrepared };
  },
};

/** Le voci che hanno un preflight. */
export const hasPreflight = (fn: ClaudeActionFn): boolean => PREFLIGHTS[fn] !== undefined;

/** Il tempo massimo di un preflight (tre chiamate alla piattaforma, 5 s l'una). */
export const PREFLIGHT_TIMEOUT_MS = 15_000;

/** Il preflight di una voce, fail-closed: un'eccezione o il tempo scaduto sono un rifiuto. */
export async function runPreflight(db: Db, user: SessionUser, fn: ClaudeActionFn, args: Record<string, unknown>, deps: PreflightDeps): Promise<PreflightResult> {
  const preflight = PREFLIGHTS[fn];
  if (!preflight) return { ok: true, prepared: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Revisione dei lotti 6–7 (M-1): allo scadere del tempo (o alla fine) le
  // chiamate alla piattaforma si FERMANO, non restano appese dopo il rifiuto.
  const controller = new AbortController();
  const timeout = new Promise<PreflightResult>((resolve) => {
    timer = setTimeout(() => resolve(refused("other", "preflight_timeout")), deps.timeoutMs ?? PREFLIGHT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([preflight(db, user, args, { ...deps, signal: controller.signal }), timeout]);
  } catch {
    return refused("other", "preflight_failed");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
