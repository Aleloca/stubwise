import { z } from "zod";

/**
 * Schemi dell'integrazione GOOGLE (Fase 6): registro dei Workspace con la loro
 * app OAuth interna, e — nei task successivi — caselle, routing della posta e
 * proposte.
 *
 * Stanno in `@stubwise/shared` perché il contratto ha più lati: il server
 * valida ed espone, la SPA disegna, il worker (dal Task 7) legge la stessa
 * forma. Nessuno dei tre deve ridichiararla.
 *
 * ⚠️ INVARIANTE: il `client_secret` dell'app OAuth NON compare mai in una
 * risposta. La proiezione pubblica ha solo il booleano `clientSecretSet`, e in
 * scrittura il campo è write-only con la semantica già usata per i segreti
 * Slack/S3 d'istanza: **assente = invariato, `""` = azzera**.
 */

// ---------------------------------------------------------------------------
// Domini del Workspace
// ---------------------------------------------------------------------------

/**
 * Un dominio email del Workspace, normalizzato: spazi tolti e tutto lowercase.
 *
 * La normalizzazione è QUI e non nella rotta perché il confronto che conta —
 * il `domain_mismatch` del callback OAuth (Task 5) — avviene fra il dominio
 * dell'email restituita da Google (già lowercase) e questa lista: se la
 * normalizzazione stesse solo nella UI, un admin che incolla "Acme.COM"
 * escluderebbe in silenzio tutte le caselle del proprio Workspace.
 *
 * Il regex chiede un dominio pieno (almeno un punto, etichette alfanumeriche
 * con trattini interni): esclude per costruzione gli indirizzi email completi
 * ("mario@acme.com" — l'errore più probabile di chi compila il form) e le
 * stringhe con spazi.
 */
export const googleDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    "must be a bare domain like acme.com (no @, no spaces)",
  );

/**
 * L'elenco dei domini: almeno uno (un Workspace senza domini non potrebbe mai
 * accettare una casella) e senza duplicati dopo la normalizzazione — "acme.com"
 * e "ACME.com" sono lo stesso dominio, e tenerli entrambi renderebbe solo più
 * confusa la lista mostrata all'admin.
 */
export const googleDomainsSchema = z
  .array(googleDomainSchema)
  .min(1)
  .max(50)
  .transform((domains) => [...new Set(domains)]);

// ---------------------------------------------------------------------------
// Scope OAuth
// ---------------------------------------------------------------------------

/**
 * Gli scope richiesti al consenso: sola lettura, il minimo che serve a leggere
 * posta ed eventi. Sono qui (e non nel solo server) perché la UI li mostra
 * all'admin nel box «Da incollare nella Google Cloud Console» e il flusso OAuth
 * del Task 5 li chiede: una lista sola, non due che divergono.
 */
export const googleOauthScopes = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

/** Il path (relativo a `PUBLIC_URL`) su cui Google rimanda dopo il consenso. */
export const GOOGLE_OAUTH_CALLBACK_PATH = "/api/me/google/callback";

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/**
 * Proiezione pubblica di un Workspace. `redirectUri` è calcolato dal server su
 * `PUBLIC_URL`: sta nella risposta e non nella UI perché è la stringa esatta da
 * incollare nella Google Cloud Console, e l'unico che conosce l'URL pubblico
 * dell'istanza (dietro proxy, sotto un dominio custom) è il server.
 *
 * `accountCount` è il numero di caselle collegate: serve alla UI per spiegare
 * perché una DELETE risponde 409 `workspace_in_use`. Nasce `.default(0)` come
 * ogni campo nuovo di una risposta (vedi CLAUDE.md, "Invarianti e trappole").
 */
export const googleWorkspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  domains: z.array(z.string()),
  clientId: z.string(),
  /** true = c'è un client secret cifrato at rest. Il valore non esce mai. */
  clientSecretSet: z.boolean(),
  accountCount: z.number().int().min(0).default(0),
  redirectUri: z.string(),
  createdAt: z.string(),
});
export type GoogleWorkspace = z.infer<typeof googleWorkspaceSchema>;

/** Creazione: nome, domini, e le due metà delle credenziali OAuth. */
export const googleWorkspaceDraftSchema = z.object({
  name: z.string().trim().min(1).max(200),
  domains: googleDomainsSchema,
  clientId: z.string().trim().min(1).max(500),
  // In creazione il secret è obbligatorio e non vuoto: un Workspace senza
  // credenziale non potrebbe collegare nessuna casella. Si azzera semmai dopo,
  // con una PATCH esplicita.
  clientSecret: z.string().min(1).max(500),
});
export type GoogleWorkspaceDraft = z.input<typeof googleWorkspaceDraftSchema>;

/**
 * Modifica: tutti i campi opzionali. Sul `clientSecret` la distinzione fra
 * **assente** e **stringa vuota** è portante e va preservata da chiunque tocchi
 * questo schema: `.optional()` senza `.default()` la rende rappresentabile
 * (`undefined` ≠ `""`), e la rotta discrimina con `!== undefined`.
 */
export const googleWorkspacePatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  domains: googleDomainsSchema.optional(),
  clientId: z.string().trim().min(1).max(500).optional(),
  clientSecret: z.string().max(500).optional(),
});
export type GoogleWorkspacePatch = z.input<typeof googleWorkspacePatchSchema>;

// ---------------------------------------------------------------------------
// Caselle collegate (Task 5)
// ---------------------------------------------------------------------------

/**
 * Proiezione pubblica di una casella Google collegata da un utente.
 *
 * ⚠️ INVARIANTE GEMELLA di quella del Workspace, e più stretta: **qui non c'è
 * NESSUN campo che possa portare il refresh token**, nemmeno un booleano — il
 * token c'è per definizione (una riga senza non esisterebbe), quindi un
 * `refreshTokenSet` non direbbe nulla e sarebbe solo un invito a metterci il
 * valore. La proiezione si costruisce campo per campo nella rotta, mai con uno
 * spread della riga; il test accanto lo verifica anche sul NOME dei campi.
 *
 * Ogni campo accessorio nasce con un default (vedi CLAUDE.md, "Invarianti e
 * trappole"): la superficie `/api/me/*` è quella che l'app mobile legge, e un
 * campo obbligatorio in più qui è un client nuovo che non sa parsare la
 * risposta di un server più vecchio.
 *
 * `disabledReason` è una `string` e non un enum chiuso di proposito: il DB ne
 * conosce cinque valori oggi (`revoked`, `invalid_grant`, `insufficient_scope`,
 * `workspace_removed`, `sync_failed`) e la UI ne traduce quelli che conosce,
 * ma un motivo aggiunto domani non deve far fallire il parse di un client
 * vecchio — stesso spirito di `readerSchema`.
 */
export const googleAccountSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  workspaceId: z.uuid(),
  /** Nome del Workspace, per non costringere la UI a una seconda chiamata. */
  workspaceName: z.string().default(""),
  scopes: z.array(z.string()).default([]),
  proposalsEnabled: z.boolean(),
  connectedAt: z.string(),
  lastSyncAt: z.string().nullable().default(null),
  disabledAt: z.string().nullable().default(null),
  disabledReason: z.string().nullable().default(null),
});
export type GoogleAccount = z.infer<typeof googleAccountSchema>;

/**
 * Un Workspace come lo vede un OPERATORE, per scegliere da quale collegarsi.
 *
 * È una proiezione a sé e non `googleWorkspaceSchema` perché la sorgente è una
 * rotta diversa con un pubblico diverso: il registro (`/api/settings/...`) è
 * solo admin e porta `clientId` e `redirectUri`, che a chi deve solo scegliere
 * una voce da una select non servono e sono dettagli di configurazione
 * dell'istanza. Qui c'è il minimo: come si chiama, quali domini serve, e se è
 * utilizzabile.
 *
 * `clientSecretSet` c'è — e la rotta non filtra i Workspace inutilizzabili —
 * perché un elenco che nasconde in silenzio la voce che l'utente si aspetta di
 * vedere è peggio di una voce disabilitata che spiega perché.
 */
export const googleWorkspaceOptionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  domains: z.array(z.string()).default([]),
  clientSecretSet: z.boolean().default(false),
});
export type GoogleWorkspaceOption = z.infer<typeof googleWorkspaceOptionSchema>;

/** Avvio del flusso: quale Workspace fa da app OAuth per questa casella. */
export const googleConnectBodySchema = z.object({ workspaceId: z.uuid() });
export type GoogleConnectBody = z.input<typeof googleConnectBodySchema>;

/**
 * Risposta di `POST /api/me/google/connect`: la URL di consenso su cui il
 * browser deve navigare. Non è un redirect del server perché la chiamata parte
 * da `fetch` nella SPA, e un 302 su una richiesta XHR verrebbe seguito dal
 * browser verso `accounts.google.com` in background — cioè in nessun posto.
 */
export const googleConnectResponseSchema = z.object({ authorizeUrl: z.string() });
export type GoogleConnectResponse = z.infer<typeof googleConnectResponseSchema>;

/** Modifica di una casella: l'unica cosa che l'utente può cambiare è il toggle. */
export const googleAccountPatchSchema = z.object({ proposalsEnabled: z.boolean() });
export type GoogleAccountPatch = z.input<typeof googleAccountPatchSchema>;

/**
 * Gli esiti che il callback OAuth comunica alla SPA nel query param `google=`.
 *
 * Sono qui e non nel solo server perché il produttore (la rotta di callback) e
 * il consumatore (il banner della pagina Account) sono due codebase diverse, e
 * una stringa scritta a mano in entrambe è una traduzione che manca senza che
 * nessun test se ne accorga.
 *
 * `error` è il catch-all: qualunque cosa vada storta con Google (rete, code
 * scaduto, credenziale sbagliata) arriva lì, perché il dettaglio sta nei log
 * del server e non nella barra degli indirizzi di chi ha solo bisogno di
 * riprovare.
 */
export const googleCallbackOutcomes = [
  "ok",
  "domain_mismatch",
  "no_refresh_token",
  "insufficient_scope",
  "error",
] as const;
export type GoogleCallbackOutcome = (typeof googleCallbackOutcomes)[number];

/** Il path della SPA su cui il callback rimanda, con `?google=<esito>`. */
export const GOOGLE_ACCOUNT_SETTINGS_PATH = "/settings/account";

// ---------------------------------------------------------------------------
// Regole di routing della posta verso un progetto (Task 6)
// ---------------------------------------------------------------------------

/**
 * I quattro criteri con cui un messaggio finisce su un progetto. Sono gli
 * stessi valori del CHECK su `project_email_routes.kind` (text con CHECK, non
 * un enum Postgres) e della `EmailRouteKind` di `@stubwise/notifications`:
 * allargarli vuol dire toccare tutti e tre i posti nella stessa PR.
 */
export const emailRouteKindSchema = z.enum([
  "sender_domain",
  "sender_address",
  "gmail_label",
  "keyword",
]);
export type EmailRouteKind = z.infer<typeof emailRouteKindSchema>;

/**
 * Una regola: il criterio e il suo valore.
 *
 * Qui il `value` è solo *ripulito* (trim, non vuoto, cappato): la forma
 * canonica vera — minuscolo, indirizzo estratto dalle parentesi angolari,
 * dominio senza `@` — la applica il server con `normalizeRouteValue` di
 * `@stubwise/notifications`, che è la STESSA funzione che il poller usa per
 * confrontare. Uno schema che normalizzasse per conto suo sarebbe una seconda
 * implementazione destinata a divergere da quella del match.
 *
 * `projectId` non c'è di proposito: viene dal path della rotta, e averlo anche
 * nel corpo aprirebbe la domanda "cosa faccio se non coincidono?".
 */
export const emailRouteSchema = z.object({
  kind: emailRouteKindSchema,
  value: z.string().trim().min(1).max(200),
});
export type EmailRoute = z.infer<typeof emailRouteSchema>;

/**
 * L'insieme delle regole di un progetto. È la risposta di GET e di PUT, e ha la
 * stessa forma del corpo del PUT così che faccia round-trip.
 */
export const emailRoutesSchema = z.object({ routes: z.array(emailRouteSchema).default([]) });
export type EmailRoutes = z.infer<typeof emailRoutesSchema>;

/**
 * Corpo del PUT: SOSTITUISCE l'insieme completo (le regole assenti spariscono),
 * come il PUT delle abilitazioni dei plugin. La UI ha davanti tutte le regole
 * del progetto e salva la foto intera; un PATCH per-regola inviterebbe solo a
 * stati parziali.
 *
 * Il tetto di 200 regole non è una politica di prodotto: è il limite oltre il
 * quale un errore di copia-incolla diventa un ciclo di match inutilmente lungo
 * su OGNI messaggio di OGNI casella.
 */
export const emailRoutesPutSchema = z.object({
  routes: z.array(emailRouteSchema).max(200),
});
export type EmailRoutesPut = z.input<typeof emailRoutesPutSchema>;

/**
 * Le etichette Gmail GIÀ OSSERVATE nella posta delle caselle di chi chiede:
 * alimentano il picker delle regole `gmail_label`, così l'admin sceglie da un
 * elenco invece di indovinare il nome esatto di una label.
 *
 * `.default([])` come ogni campo nuovo di una risposta: finché il poller (Task
 * 7) non esiste la lista è vuota, e vuota deve restare una risposta valida.
 */
export const emailLabelsSchema = z.object({ labels: z.array(z.string()).default([]) });
export type EmailLabels = z.infer<typeof emailLabelsSchema>;
