import type { CredentialCheck } from "./provider.js";

/**
 * Scope degli API token Bitbucket che Stubwise usa, definiti UNA volta sola.
 * Sono i nomi degli API token Atlassian (`<azione>:<risorsa>:bitbucket`), non
 * quelli di OAuth (`repository:write`) né quelli delle app password legacy
 * («Repositories: Write»): vedi CLAUDE.md, «Due nomenclature da non mescolare».
 */
export const BITBUCKET_SCOPES = {
  readRepository: "read:repository:bitbucket",
  writeRepository: "write:repository:bitbucket",
  readPullRequest: "read:pullrequest:bitbucket",
  writePullRequest: "write:pullrequest:bitbucket",
  readWebhook: "read:webhook:bitbucket",
  writeWebhook: "write:webhook:bitbucket",
  readUser: "read:user:bitbucket",
} as const;

export type BitbucketScope = (typeof BITBUCKET_SCOPES)[keyof typeof BITBUCKET_SCOPES];

const S = BITBUCKET_SCOPES;

/**
 * Scope che servono all'account REVISORE: legge e scrive repository e PR (la
 * review, lo stato della PR) e legge la propria identità. I `read:` stanno
 * accanto ai `write:` finché non è verificato che un `write:` includa il suo
 * `read:` (riserva T43 del B14). Niente webhook: il revisore non li configura.
 */
export const BITBUCKET_REVIEWER_SCOPES: readonly BitbucketScope[] = [
  S.readRepository,
  S.writeRepository,
  S.readPullRequest,
  S.writePullRequest,
  S.readUser,
];

/** Scope che servono all'account PRINCIPALE: quelli del revisore più i webhook. */
export const BITBUCKET_PRIMARY_SCOPES: readonly BitbucketScope[] = [
  ...BITBUCKET_REVIEWER_SCOPES,
  S.readWebhook,
  S.writeWebhook,
];

/**
 * L'insieme richiesto a un account secondo il suo RUOLO, che conosce solo il
 * server (`repositories.git_account_id` / `review_git_account_id`). Entrambi i
 * ruoli → l'unione; nessuno (account non ancora usato) → quello del principale,
 * cioè il più esigente: un account nuovo nasce di solito per fare da principale.
 */
export function bitbucketRequiredScopes(role: { primary: boolean; reviewer: boolean }): BitbucketScope[] {
  if (!role.primary && !role.reviewer) return [...BITBUCKET_PRIMARY_SCOPES];
  const set = new Set<BitbucketScope>();
  if (role.primary) for (const s of BITBUCKET_PRIMARY_SCOPES) set.add(s);
  if (role.reviewer) for (const s of BITBUCKET_REVIEWER_SCOPES) set.add(s);
  return [...set];
}

/**
 * Legge l'header `x-oauth-scopes` (gli scope CONCESSI, «a, b, c»). Tollerante:
 * spazi attorno, maiuscole, virgole senza spazio, voci vuote. `null` se
 * l'header manca: «non lo sappiamo», non «nessuno scope».
 */
export function parseBitbucketScopes(header: string | null | undefined): Set<string> | null {
  if (header === null || header === undefined) return null;
  return new Set(
    header
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  );
}

/** Un gruppo di scope, con a cosa serve: un check per gruppo. */
interface ScopeGroup {
  name: string;
  scopes: readonly BitbucketScope[];
  /** Cosa succede senza: chiude il dettaglio di un check fallito. */
  missingConsequence: string;
  /** Cosa permettono: dettaglio di un check passato. */
  okDetail: string;
}

const SCOPE_GROUPS: readonly ScopeGroup[] = [
  {
    name: "Scope repository e pull request",
    scopes: [S.readRepository, S.writeRepository, S.readPullRequest, S.writePullRequest],
    missingConsequence:
      "servono a clonare il repository, pushare i branch del fix e aprire o recensire le pull request",
    okDetail: "il token può leggere e scrivere repository e pull request",
  },
  {
    name: "Scope identità (read:user)",
    scopes: [S.readUser],
    missingConsequence:
      "senza, Stubwise non sa chi è l'account e i Request changes da Bitbucket vengono scartati",
    okDetail: "il token può leggere la propria identità (serve ai Request changes da Bitbucket)",
  },
  {
    name: "Scope webhook",
    scopes: [S.readWebhook, S.writeWebhook],
    missingConsequence: "servono a registrare il webhook del repository (PR, push, Request changes)",
    okDetail: "il token può gestire i webhook del repository",
  },
];

/**
 * Trasforma gli header di una risposta 2xx di api.bitbucket.org nei check
 * sugli scope. Un check per gruppo (repository/PR, identità, webhook), e solo
 * per i gruppi che `required` tocca: al revisore non si chiede il gruppo
 * webhook. Nessun `purpose`: questi check vengono da `validateAccount`, e
 * `purpose: "webhook"` è ciò che `checkReviewAccount` del server SCARTA per il
 * revisore — riusarlo qui inviterebbe a filtrare un check che il ruolo ha già
 * deciso di chiedere o non chiedere.
 *
 * **Credenziale non verificabile** (header `x-credential-type` diverso da
 * `api_token`, o `x-oauth-scopes` assente o VUOTO — tipicamente un'app
 * password legacy): non si deduce niente. Si restituisce UN check «Scope del token» con
 * `ok: true` e un dettaglio che dice che non è verificabile ed elenca cosa
 * controllare a mano. Perché `ok: true`: il verdetto complessivo della rotta è
 * `checks.every(ok)` e la UI lo mostra rosso («problemi»); con `ok: false` un
 * account con app password — che Stubwise accetta ancora — sarebbe rosso a
 * OGNI validazione per un fatto che nessuna azione dell'utente può cambiare
 * (non c'è un header da far comparire), cioè un falso ko permanente. Il check
 * dice nel nome e nel dettaglio che non ha verificato: non afferma che gli
 * scope ci siano.
 */
export function bitbucketScopeChecks(
  headers: Headers,
  required: readonly BitbucketScope[]
): CredentialCheck[] {
  const credentialType = headers.get("x-credential-type")?.trim().toLowerCase() ?? null;
  const granted = parseBitbucketScopes(headers.get("x-oauth-scopes"));
  const requiredSet = new Set(required);

  // Header PRESENTE ma VUOTO vale come assente: un API token senza nessuno
  // scope non autenticherebbe nemmeno la chiamata che ha prodotto questo 200,
  // quindi un elenco vuoto è un header che non dice niente, non «manca tutto».
  if (credentialType !== "api_token" || granted === null || granted.size === 0) {
    return [
      {
        name: "Scope del token",
        ok: true,
        detail:
          "non verificabili per questo tipo di credenziale (Bitbucket non dichiara gli scope, es. app password legacy): " +
          `controlla a mano che abbia ${[...requiredSet].join(", ")}`,
      },
    ];
  }

  const checks: CredentialCheck[] = [];
  for (const group of SCOPE_GROUPS) {
    const wanted = group.scopes.filter((s) => requiredSet.has(s));
    if (wanted.length === 0) continue;
    const missing = wanted.filter((s) => !granted.has(s));
    checks.push(
      missing.length === 0
        ? { name: group.name, ok: true, detail: group.okDetail }
        : {
            name: group.name,
            ok: false,
            detail: `mancano ${missing.join(", ")}: ${group.missingConsequence}`,
          }
    );
  }
  return checks;
}

/** Una lista di scope nel corpo di un errore: array di stringhe o stringa «a, b». */
function scopeList(value: unknown): string[] | null {
  if (typeof value === "string") return [...(parseBitbucketScopes(value) ?? [])];
  if (Array.isArray(value)) {
    return value
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  }
  return null;
}

/**
 * D12: sul 403 di api.bitbucket.org il corpo JSON dice cosa serviva
 * (`error.detail.required`) e cosa il token ha (`error.detail.granted`).
 * Restituisce gli scope richiesti MANCANTI (`required − granted`, nell'ordine
 * di `required`), così il dettaglio del check nomina solo quelli. Qualunque
 * corpo diverso — non JSON, senza `required`, illeggibile — dà `[]`, e il
 * chiamante tiene il messaggio di sempre: niente si deduce da un corpo che non
 * lo dice. `granted` assente = nessuno scope dichiarato.
 */
export function bitbucketMissingScopesFrom403(body: string | null): string[] {
  if (body === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const detail = (parsed as { error?: { detail?: { required?: unknown; granted?: unknown } } } | null)
    ?.error?.detail;
  if (typeof detail !== "object" || detail === null) return [];
  const required = scopeList(detail.required);
  if (required === null) return [];
  const granted = new Set(scopeList(detail.granted) ?? []);
  return [...new Set(required.filter((s) => !granted.has(s)))];
}
