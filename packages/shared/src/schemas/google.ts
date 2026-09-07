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
