import { decrypt, gitAccounts, prCorrections, type Db } from "@stubwise/db";
import type { GitProviderKind, PrComment } from "@stubwise/shared";
import { and, desc, eq } from "drizzle-orm";

/**
 * Identità degli account di Stubwise sulla piattaforma e fotografia dei
 * commenti della PR (ciclo di correzione post-PR, design §4-§5). L'identità
 * la usano il webhook del server (`services/pr-correction-webhook.ts`) e il
 * worker; la fotografia (taglio + filtro) solo il worker, che la fa
 * all'avvio di ogni correzione chiesta dalla piattaforma.
 *
 * Questo package non dipende da `@stubwise/git`, e non deve: la chiamata al
 * provider arriva INIETTATA ({@link FetchPlatformIdentity}).
 */

/** Credenziali git in chiaro di un account (stessa forma di `routes/git-accounts.ts`). */
export interface GitCredentials {
  username?: string;
  email?: string;
  token: string;
}

/** Le credenziali in chiaro di un account, o `null` se il blob non si decifra. */
export function decryptGitCredentials(
  encryptedCredentials: string,
  encryptionKey: Buffer,
): GitCredentials | null {
  try {
    const parsed = JSON.parse(decrypt(encryptedCredentials, encryptionKey)) as Partial<GitCredentials>;
    if (typeof parsed.token !== "string" || parsed.token === "") return null;
    return {
      ...(typeof parsed.username === "string" ? { username: parsed.username } : {}),
      ...(typeof parsed.email === "string" ? { email: parsed.email } : {}),
      token: parsed.token,
    };
  } catch {
    return null;
  }
}

/** Quel poco della riga `git_accounts` che serve a risolvere l'identità. */
export interface IdentityAccount {
  id: string;
  provider: GitProviderKind;
  encryptedCredentials: string;
  providerUserId: string | null;
}

/**
 * Chi è il token sulla piattaforma. Server e worker passano
 * `({ provider, credentials }) => getProvider(provider).getAuthenticatedUserId({ credentials })`.
 */
export type FetchPlatformIdentity = (input: {
  provider: GitProviderKind;
  credentials: GitCredentials;
}) => Promise<string>;

/**
 * L'id dell'account sulla piattaforma (uuid Bitbucket, id GitHub): quello
 * salvato se c'è, altrimenti lo chiede al provider e lo salva. `null` — MAI
 * un valore di ripiego — se le credenziali non si decifrano o il provider non
 * risponde (su Bitbucket un token senza lo scope `read:user:bitbucket` prende
 * 403): chi ci costruisce sopra una difesa deve poter chiudere il cancello
 * (design §5, fail-closed).
 *
 * L'id restituito è SEMPRE quello salvato: il salvataggio è guardato sul blob
 * delle credenziali letto all'inizio (fa da versione, l'IV è casuale), così
 * una risposta del provider partita col token vecchio non riscrive la cache
 * dopo che un PATCH l'ha azzerata. Se la scrittura non tocca nessuna riga, o
 * il DB dà errore: `null`.
 *
 * `refresh` ignora la cache: lo usa il salvataggio dell'account revisore, il
 * momento in cui l'admin deve sapere se funziona davvero.
 *
 * `onError` riceve l'errore del provider (es. il GitProviderError del 401/403,
 * il cui messaggio dice PERCHÉ l'identità non si risolve, senza token) prima
 * che la funzione restituisca `null`: serve al chiamante per scriverlo nel
 * log. Non cambia l'esito (resta fail-closed), e un `onError` che lancia non
 * trasforma il `null` in un'eccezione.
 */
export async function resolveProviderUserId(
  db: Db,
  encryptionKey: Buffer,
  account: IdentityAccount,
  fetchIdentity: FetchPlatformIdentity,
  opts: { refresh?: boolean; onError?: (err: unknown) => void } = {},
): Promise<string | null> {
  if (account.providerUserId && !opts.refresh) return account.providerUserId;
  const credentials = decryptGitCredentials(account.encryptedCredentials, encryptionKey);
  if (!credentials) return null;
  let providerUserId: string;
  try {
    providerUserId = await fetchIdentity({ provider: account.provider, credentials });
  } catch (err) {
    try {
      opts.onError?.(err);
    } catch {
      // Il log non deve cambiare l'esito: resta null.
    }
    return null;
  }
  if (!providerUserId) return null;
  // Scrittura GUARDATA sul blob letto: l'IV di `encrypt` è casuale, quindi il
  // blob fa da versione delle credenziali. Se nel frattempo un PATCH le ha
  // cambiate (e ha azzerato la cache), l'id appena letto è del token VECCHIO:
  // scriverlo renderebbe fail-open il filtro anti-auto-innesco. Nessuna riga
  // scritta, o un errore del DB → null.
  try {
    const written = await db
      .update(gitAccounts)
      .set({ providerUserId })
      .where(
        and(
          eq(gitAccounts.id, account.id),
          eq(gitAccounts.encryptedCredentials, account.encryptedCredentials),
        ),
      )
      .returning({ id: gitAccounts.id });
    return written.length > 0 ? providerUserId : null;
  } catch {
    return null;
  }
}

/**
 * L'istante dopo cui un commento della PR non è ancora stato consegnato
 * all'AI: il `created_at` dell'ultima correzione CONCLUSA che aveva una
 * fotografia COMPLETA (`feedback_complete`, emendamento E1: una lettura dei
 * commenti fallita lascia la sola fotografia minima del webhook, e tagliare lì
 * salterebbe per sempre i commenti scritti prima, mai letti). `null` = nessun
 * taglio (tutti i commenti della PR).
 *
 * Non l'«ultimo push» qualsiasi: una correzione automatica (`trigger =
 * 'review'`) pusha senza aver fotografato la PR, e tagliare lì perderebbe i
 * commenti scritti prima, che nessuno ha mai letto. L'errore residuo è per
 * eccesso (un commento già letto può ricomparire), mai per difetto.
 */
export async function providerFeedbackCutoff(
  db: Db,
  pr: { repositoryId: string; prNumber: number },
): Promise<Date | null> {
  const [last] = await db
    .select({ createdAt: prCorrections.createdAt })
    .from(prCorrections)
    .where(
      and(
        eq(prCorrections.repositoryId, pr.repositoryId),
        eq(prCorrections.prNumber, pr.prNumber),
        eq(prCorrections.status, "done"),
        // Emendamento E1: non basta che una fotografia ci sia — quella minima
        // del webhook esiste anche quando la lettura dei commenti è fallita.
        // Taglia solo una fotografia letta DAVVERO dal provider.
        eq(prCorrections.feedbackComplete, true),
      ),
    )
    .orderBy(desc(prCorrections.createdAt))
    .limit(1);
  return last?.createdAt ?? null;
}

/**
 * Chi, su GitHub, ha il permesso di far ripartire il ciclo di correzione: il
 * proprietario del repository, un membro dell'organizzazione, un
 * collaboratore. Sono i valori di `author_association` (maiuscoli, come
 * GitHub li manda). Tutto il resto — `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`,
 * `FIRST_TIMER`, `MANNEQUIN`, `NONE` — è qualcuno che su un repository
 * PUBBLICO può scrivere, ma non decidere cosa si corregge.
 */
export const TRUSTED_AUTHOR_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"] as const;

const TRUSTED = new Set<string>(TRUSTED_AUTHOR_ASSOCIATIONS);

/**
 * L'autore di una richiesta di modifiche o di un commento ha il permesso di
 * chiederle? Regola dell'utente: «chi ha il PERMESSO sulla piattaforma di
 * chiedere modifiche fa ripartire il ciclo» — senza, un estraneo su un
 * repository pubblico spenderebbe budget e metterebbe testo nel prompt.
 *
 * - **GitHub**: solo se `association` è in {@link TRUSTED_AUTHOR_ASSOCIATIONS}.
 *   `null`/assente NON passa (fail-closed): GitHub il campo lo manda sempre,
 *   quindi la sua assenza è un'anomalia, non un «non so» da concedere.
 * - **Bitbucket**: sempre ammesso. Non esiste un dato equivalente (il valore
 *   è sempre `null`), e i repository su cui gira oggi sono privati — chi può
 *   commentare ha già accesso. Rischio accettato e documentato nel piano
 *   ("Decisioni e rischi"), da rivedere dopo la verifica manuale B14 su un
 *   repository Bitbucket pubblico.
 *
 * UNA funzione per il webhook (la review "Request changes") e per la
 * fotografia dei commenti: le due porte non devono poter dire cose diverse.
 */
export function isTrustedAuthorAssociation(
  association: string | null | undefined,
  provider: GitProviderKind,
): boolean {
  if (provider === "bitbucket") return true;
  return typeof association === "string" && TRUSTED.has(association);
}

/**
 * I commenti che entrano nella fotografia: non scritti dagli account di
 * Stubwise (la review l'AI la riceve già dal DB, e un commento del bot non è
 * feedback umano), scritti DOPO il taglio, e di un autore che ha il permesso
 * di chiedere modifiche ({@link isTrustedAuthorAssociation} col `provider`
 * della repository: su GitHub un commento di un estraneo non entra nel
 * prompt).
 *
 * - `provider` è OBBLIGATORIO apposta: un chiamante che lo dimenticasse
 *   aprirebbe la porta agli estranei senza che niente lo segnali. Il
 *   compilatore lo segnala.
 * - Un `createdAt` non parsabile il commento lo TIENE: errore per eccesso,
 *   mai per difetto. Per l'autore vale il contrario (fail-closed su GitHub):
 *   un commento in più di un estraneo non è un errore innocuo.
 * - Limite noto: un commento MODIFICATO dopo il taglio si perde, perché
 *   `PrComment` non ha `updatedAt` (conta solo la data di creazione).
 * - L'ordine dell'output è quello del provider.
 */
export function selectProviderFeedback(
  comments: readonly PrComment[],
  opts: { cutoff: Date | null; ownIds: readonly string[]; provider: GitProviderKind },
): PrComment[] {
  const own = new Set(opts.ownIds);
  return comments.filter(
    (c) =>
      !own.has(c.authorId) &&
      isTrustedAuthorAssociation(c.authorAssociation, opts.provider) &&
      (opts.cutoff === null || !isBeforeOrAt(c.createdAt, opts.cutoff)),
  );
}

function isBeforeOrAt(createdAt: string, cutoff: Date): boolean {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return t <= cutoff.getTime();
}
