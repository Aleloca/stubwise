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
 *
 * `email_not_verified` ed `mailbox_owned_by_other` (fase 6, Task 5 di review)
 * sono due rifiuti che, come gli altri, non scrivono NESSUNA riga: il primo
 * perché `userinfo.emailVerified` è falso (Google stesso non garantisce
 * l'identità), il secondo perché l'email risulta già collegata da un utente
 * DIVERSO — senza questo esito il ricollegamento trasferirebbe la casella (e
 * la sua storia di `email_messages`/`calendar_events`) in silenzio.
 */
export const googleCallbackOutcomes = [
  "ok",
  "domain_mismatch",
  "no_refresh_token",
  "insufficient_scope",
  "email_not_verified",
  "mailbox_owned_by_other",
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

// ---------------------------------------------------------------------------
// Ammissione della posta (fase 6c): configurazione D'ISTANZA, separata
// dall'attribuzione per progetto (le regole sopra, invariate).
// ---------------------------------------------------------------------------

/**
 * Configurazione d'istanza dell'AMMISSIONE della posta: decide SE un
 * messaggio entra nella pipeline, non A QUALE progetto va (quello resta
 * `project_email_routes`, sopra). È la risposta di `GET
 * /api/settings/mail-admission` e la forma "vista" di
 * `PATCH /api/settings/mail-admission`.
 *
 * Ogni campo è `.default()`: sono TRE campi nuovi su una risposta — nessuna
 * app mobile la consuma oggi (questa rotta non è fra quelle lette dal client
 * mobile), ma la convenzione del repo per campi nuovi in uno schema di
 * risposta è comunque senza eccezioni, vedi CLAUDE.md.
 */
export const mailAdmissionSchema = z.object({
  // I mittenti (o destinatari in copia) dei domini di un Google Workspace
  // registrato ammettono la posta senza bisogno di una regola di progetto.
  // Default true: allarga il perimetro di oggi, non lo restringe — una
  // regola di progetto che già ammette un messaggio continua ad ammetterlo.
  admitWorkspaceDomains: z.boolean().default(true),
  // Etichette Gmail che escludono SEMPRE, anche quando una regola di
  // progetto o il dominio del Workspace ammetterebbero.
  denyLabels: z
    .array(z.string())
    .default(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "SPAM"]),
  // Scarta la posta automatica (List-Unsubscribe, List-Id, Precedence: bulk,
  // Auto-Submitted diverso da "no").
  denyAutomated: z.boolean().default(true),
});
export type MailAdmission = z.infer<typeof mailAdmissionSchema>;

/**
 * Corpo del PATCH: semantica patch, non put — campo ASSENTE = non toccato,
 * come `PATCH /api/me/notification-prefs` (vedi il docblock in
 * `apps/server/src/routes/me-prefs.ts`). Tutti e tre i campi sono nuovi:
 * renderli obbligatori romperebbe qualunque chiamante che non li conosce
 * ancora, esattamente il caso descritto in CLAUDE.md per un body che cresce.
 */
export const mailAdmissionPatchSchema = z.object({
  admitWorkspaceDomains: z.boolean().optional(),
  denyLabels: z.array(z.string()).max(50).optional(),
  denyAutomated: z.boolean().optional(),
});
export type MailAdmissionPatch = z.input<typeof mailAdmissionPatchSchema>;

// ---------------------------------------------------------------------------
// Pagina Posta (Task 12): messaggi ed eventi TRATTATI, per utente
// ---------------------------------------------------------------------------

/** Da dove nasce la riga: una email o un evento di calendario. */
export const mailSourceSchema = z.enum(["email", "calendar"]);
export type MailSource = z.infer<typeof mailSourceSchema>;

/**
 * Fase 6c (fix di review, Task 3): CHE COSA rappresenta la riga, ortogonale a
 * {@link mailSourceSchema} — che dice solo DA QUALE TABELLA fisica viene la
 * riga (email vs calendario), non se è già attribuita a un progetto.
 * `"proposal"` è una proposta NORMALE con un progetto risolto
 * (`email_proposals`, o un evento di calendario); `"calendar"` è un evento
 * di calendario (ridondante con `source: "calendar"`, ma esplicito, per
 * simmetria); `"triage"` è una proposta di SMISTAMENTO (`classify.ts`,
 * `EmailTriageClassification` — un padre `email_messages` SENZA figli, con
 * `projectId`/`projectName` sempre `null`): la UI la rende diversamente
 * (nessun badge di progetto, un'etichetta «da smistare», l'esito «nessuno di
 * questi» leggibile invece del generico "ignored").
 */
export const mailItemKindSchema = z.enum(["proposal", "triage", "calendar"]);
export type MailItemKind = z.infer<typeof mailItemKindSchema>;

/**
 * Stato NORMALIZZATO di una riga della pagina Posta, uguale per le due
 * sorgenti anche se le colonne sottostanti non lo sono: `email_messages.status`
 * ha esattamente questi valori, `calendar_events` non ha una colonna di
 * workflow gemella (la sua `status` è quella di GOOGLE — confirmed/tentative/
 * cancelled) e il server la deriva da `outcome`/`proposal_notification_id`
 * (vedi `deriveCalendarMailStatus` in `apps/server/src/routes/me-mail.ts`).
 * Un unico vocabolario è ciò che permette a `?status=failed` di filtrare le
 * due tabelle allo stesso modo, ed è ciò che decide se «Riproponi» compare.
 */
export const mailItemStatusSchema = z.enum([
  "new",
  "classified",
  "proposed",
  "actioned",
  "ignored",
  "failed",
  "cancelled",
]);
export type MailItemStatus = z.infer<typeof mailItemStatusSchema>;

/** Il segnale riconosciuto dalla classificazione. Assente sugli eventi di calendario (non c'è AI). */
export const mailSignalSchema = z.enum(["decision", "request", "deadline", "blocker", "none"]);
export type MailSignal = z.infer<typeof mailSignalSchema>;

/**
 * UNA riga della pagina Posta: un messaggio Gmail o un evento di calendario
 * TRATTATO, nella forma UNIFICATA che la UI consuma senza sapere da quale
 * tabella viene (`source` distingue le due, per chi deve costruire il link
 * di «Riproponi»).
 *
 * `from` è il mittente della email o l'organizzatore dell'evento; `title` è
 * l'oggetto o il titolo. Entrambi TESTO NON FIDATO (li scrive chi ha mandato
 * la email o creato l'evento): chi li rende su una superficie con markup li
 * escapa, come `from`/`subject` di `inboxGoogleSchema`.
 *
 * `reproposable` è calcolato dal server (stesso criterio di
 * `POST /api/me/mail/:source/:id/repropose`: `status` `failed` o `ignored`) —
 * la UI non lo deduce da `status` per non duplicare quella regola.
 *
 * ⚠️ Fase 6b — rottura di contratto DICHIARATA nel design (§6, "Pagina
 * Posta"): per `source: "email"`, `id` è ormai `email_proposals.id` (il
 * FIGLIO, una riga per progetto), **non più** `email_messages.id`. Un
 * messaggio con tre proposte produce tre righe con lo stesso mittente e lo
 * stesso oggetto e TRE `id` diversi — è quella riga, non il messaggio, che
 * `POST /:source/:id/repropose` chiude. Per `source: "calendar"`, invece,
 * `id` resta `calendar_events.id`: il calendario è rimasto uno a uno,
 * nessun figlio. Accettata perché la pagina Posta è stata deployata lo
 * stesso giorno di questo cambio e nessun client si è ancora costruito
 * sopra un `id` che significasse "messaggio" per l'email.
 *
 * ⚠️ Fase 6c (fix di review, Task 3) — un TERZO spazio di `id` per
 * `source: "email"`: quando `kind: "triage"`, `id` è `email_messages.id` (il
 * PADRE stesso, nessun figlio per costruzione — vedi
 * {@link mailItemKindSchema}), non `email_proposals.id`. La rotta di
 * repropose lo disambigua nel PATH (`source: "email_triage"`, un terzo
 * valore accettato SOLO da `POST /:source/:id/repropose`, non da
 * `mailSourceSchema`/questo campo `source`): un `id` da solo non basta a
 * scegliere la tabella giusta (sono UUID indipendenti), e il path elimina
 * per costruzione l'errore di mandare l'id giusto col `source` sbagliato —
 * stessa ragione della scelta fra `/email/:id` e `/calendar/:id` qui sopra.
 */
export const mailItemSchema = z.object({
  id: z.uuid(),
  source: mailSourceSchema,
  /**
   * Fase 6c (fix di review, Task 3): che TIPO di riga è, non da quale
   * TABELLA viene (`source` sopra). `.default("proposal")` — il valore
   * storico, prima che questo campo esistesse — per reggere una risposta
   * scritta da un server più vecchio (vedi CLAUDE.md, "Invarianti e
   * trappole": ogni campo nuovo di risposta nasce opzionale/default, mai
   * obbligatorio).
   */
  kind: mailItemKindSchema.optional().default("proposal"),
  accountId: z.uuid(),
  /** L'email della casella Google da cui la riga è arrivata. */
  accountEmail: z.string(),
  /**
   * Il progetto della riga. Fase 6b: per `source: "email"` è ora SEMPRE
   * valorizzato (una riga `email_proposals` ha `project_id NOT NULL` — è il
   * progetto di QUESTA proposta, non più «il vincitore del routing, se
   * risolto»); resta `.nullable()` per compatibilità di schema e per il
   * calendario, dove un evento può restare senza progetto risolto.
   */
  projectId: z.uuid().nullable(),
  /** Nome del progetto, per non costringere la UI a una seconda chiamata. `null` = non risolto. */
  projectName: z.string().nullable().default(null),
  /** Oggetto della email o titolo dell'evento. NON FIDATO. */
  title: z.string().nullable().default(null),
  /** Mittente della email o organizzatore dell'evento. NON FIDATO. */
  from: z.string().nullable().default(null),
  /** Quando la email è arrivata, o quando l'evento comincia. */
  date: z.iso.datetime(),
  status: mailItemStatusSchema,
  /** `null` sugli eventi di calendario (nessuna classificazione AI) e sui messaggi non ancora classificati. */
  signal: mailSignalSchema.nullable().default(null),
  /** Esito dell'azione confermata (id creati, `exists`, `cancelled`, `failed`+`error`…), se già chiusa. */
  outcome: z.record(z.string(), z.unknown()).nullable().default(null),
  /** Messaggio TECNICO del fallimento (mai il testo dell'email), se `status: "failed"`. */
  error: z.string().nullable().default(null),
  /** Link al thread Gmail o all'evento del calendario. `null` se non ricostruibile. */
  url: z.string().nullable().default(null),
  reproposable: z.boolean().default(false),
});
export type MailItem = z.infer<typeof mailItemSchema>;

/** Pagina della lista Posta: `nextCursor` null quando non c'è altro da leggere. */
export const mailPageSchema = z.object({
  items: z.array(mailItemSchema),
  nextCursor: z.string().nullable(),
});
export type MailPage = z.infer<typeof mailPageSchema>;

/**
 * Contatori per il badge di nav e l'intestazione della pagina. `openProposals`
 * è quello che alimenta il badge (le proposte APERTE, cioè le notifiche
 * `google.proposal` non ancora gestite di questo utente — non lo stato delle
 * righe di posta, che può restare `proposed` anche dopo che la notifica è
 * stata archiviata senza confermare un'opzione).
 */
export const mailSummarySchema = z.object({
  openProposals: z.number().int().min(0).default(0),
  failed: z.number().int().min(0).default(0),
  ignored: z.number().int().min(0).default(0),
});
export type MailSummary = z.infer<typeof mailSummarySchema>;

/** Risposta di `POST /api/me/mail/:source/:id/repropose`: nessun dato oltre l'esito. */
export const mailReproposeResultSchema = z.object({ ok: z.literal(true) });
export type MailReproposeResult = z.infer<typeof mailReproposeResultSchema>;

// ---------------------------------------------------------------------------
// Il dettaglio di un'email (fase 7b, Task 6-7)
// ---------------------------------------------------------------------------

/**
 * `GET /api/me/mail/:source/:id`: il dettaglio di un messaggio, dall'estratto
 * GIÀ in database — nessuna chiamata a Google, funziona anche a token scaduto
 * o con Google irraggiungibile (design fase 7b §3).
 *
 * `textExcerpt` DICHIARA di essere un estratto: testo ripulito, senza
 * citazioni, firma né allegati — è il testo che ha visto il classificatore,
 * non il messaggio. `null` quando il poller non l'ha salvato (un messaggio
 * più vecchio della fase 6, o senza corpo estraibile): non è un errore, la
 * UI mostra che l'estratto non è disponibile invece di un campo vuoto.
 * NON FIDATO come `subject`/`from`: lo scrive chi ha mandato l'email.
 */
export const mailDetailSchema = z.object({
  id: z.uuid(),
  source: mailSourceSchema,
  accountId: z.uuid(),
  accountEmail: z.string(),
  from: z.string(),
  to: z.array(z.string()).default([]),
  subject: z.string().nullable(),
  receivedAt: z.iso.datetime(),
  labels: z.array(z.string()).default([]),
  textExcerpt: z.string().nullable(),
  /** Link al thread Gmail: è dove porta «Apri su Gmail». */
  url: z.string(),
});
export type MailDetail = z.infer<typeof mailDetailSchema>;

/**
 * `GET /api/me/mail/:source/:id/original`: il messaggio riletto da Gmail SU
 * RICHIESTA (design fase 7b §3, punto 2) — non si persiste nulla di questo:
 * è una finestra su Gmail, non una copia.
 *
 * ⚠️ **Solo `bodyText`, MAI l'HTML originale**: il corpo di un'email è testo
 * NON FIDATO scritto da chi vuole, e un client web non deve mai iniettarlo
 * come markup (`dangerouslySetInnerHTML` su un'email è un vettore XSS
 * diretto — script inline, `onerror` su un'immagine, ecc.). Il server
 * converte l'HTML in testo quando manca il `text/plain` (stessa funzione
 * `htmlToText` di `@stubwise/google` usata per l'estratto): `bodyText` è
 * quindi `null` SOLO se il messaggio non aveva proprio corpo.
 */
export const mailOriginalSchema = z.object({
  subject: z.string().nullable(),
  from: z.string(),
  to: z.array(z.string()).default([]),
  cc: z.array(z.string()).default([]),
  bodyText: z.string().nullable(),
  attachments: z
    .array(z.object({ filename: z.string(), mimeType: z.string().nullable() }))
    .default([]),
});
export type MailOriginal = z.infer<typeof mailOriginalSchema>;

// ---------------------------------------------------------------------------
// Sezione Calendario (fase 7b): superficie dedicata, con la stessa ACL della
// Posta (`user_id` sempre nel WHERE). `GET /api/me/calendar` mostra GLI
// APPUNTAMENTI VISTI (una riga per occorrenza, come la posta); `GET
// /api/me/calendar/series` mostra LE SERIE RICONOSCIUTE con la loro
// configurazione — design fase 7b §4.
// ---------------------------------------------------------------------------

/**
 * L'azione che una serie configurata produce (design fase 7b §4). Riusa
 * `google.proposal` con `source: "calendar"` — nessun kind di notifica nuovo
 * e nessun valore nuovo in `ProposalSource.source` (vedi CLAUDE.md): quale
 * azione eseguire lo dice questa colonna, letta dalla riga, non il payload.
 */
export const calendarSeriesActionSchema = z.enum(["backlog_item", "milestone", "reminder"]);
export type CalendarSeriesAction = z.infer<typeof calendarSeriesActionSchema>;

/**
 * UN appuntamento visto: un'occorrenza di `calendar_events`, con lo stato
 * NORMALIZZATO della proposta che ne è nata (vocabolario condiviso con
 * `mailItemStatusSchema` — stessa CASE, vedi `calendar-status.ts` sul
 * server) e il suo esito.
 *
 * `recurringEventId` (fase 7b, Task 1) è `null` per un evento singolo — la
 * maggioranza — e collega la riga alla SUA serie in
 * {@link calendarSeriesItemSchema}. `title`/`organizer` sono testo NON
 * FIDATO (li scrive chi ha creato l'evento): chi li rende su una superficie
 * con markup li escapa, come `title`/`from` di {@link mailItemSchema}.
 */
export const calendarEventItemSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  accountEmail: z.string(),
  recurringEventId: z.string().nullable().default(null),
  projectId: z.uuid().nullable(),
  projectName: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  organizer: z.string().nullable().default(null),
  startsAt: z.iso.datetime(),
  status: mailItemStatusSchema,
  outcome: z.record(z.string(), z.unknown()).nullable().default(null),
  error: z.string().nullable().default(null),
  /** Link alla giornata sul calendario Google della casella. `null` se non ricostruibile. */
  url: z.string().nullable().default(null),
  reproposable: z.boolean().default(false),
});
export type CalendarEventItem = z.infer<typeof calendarEventItemSchema>;

/** Pagina di `GET /api/me/calendar`: `nextCursor` null quando non c'è altro da leggere. */
export const calendarEventPageSchema = z.object({
  items: z.array(calendarEventItemSchema),
  nextCursor: z.string().nullable(),
});
export type CalendarEventPage = z.infer<typeof calendarEventPageSchema>;

/**
 * UNA serie ricorrente riconosciuta: derivata raggruppando `calendar_events`
 * per `(account_id, recurring_event_id)`, con la configurazione di
 * {@link CalendarSeriesRow} se esiste (altrimenti i default — una serie non
 * configurata è una serie SPENTA, mai un errore: design fase 7b §4, "Default
 * spento, e non è un dettaglio di prudenza").
 *
 * `occurrenceCount`/`nextOccurrenceAt` vengono dalle occorrenze GIÀ tracciate
 * (dentro la finestra dei 60 giorni, dopo il fix del Task 2): le 730
 * occorrenze passate del 9 settembre 2026 compaiono come una serie con
 * `nextOccurrenceAt: null` — spenta, senza nulla in arrivo — che il
 * maintainer può comunque accendere se vuole.
 */
export const calendarSeriesItemSchema = z.object({
  accountId: z.uuid(),
  accountEmail: z.string(),
  recurringEventId: z.string(),
  /** Il titolo dell'occorrenza più recente vista. NON FIDATO. */
  title: z.string().nullable().default(null),
  occurrenceCount: z.number().int().min(0).default(0),
  /** La prossima occorrenza NON ANCORA passata, o `null` se non ce n'è nessuna tracciata. */
  nextOccurrenceAt: z.iso.datetime().nullable().default(null),
  enabled: z.boolean().default(false),
  projectId: z.uuid().nullable().default(null),
  projectName: z.string().nullable().default(null),
  action: calendarSeriesActionSchema.default("milestone"),
  leadDays: z.number().int().min(0).max(30).default(2),
  /** `false` = propone e aspetta un tap; `true` = esegue e lo rende visibile. MAI un job AI. */
  auto: z.boolean().default(false),
});
export type CalendarSeriesItem = z.infer<typeof calendarSeriesItemSchema>;

/** Risposta di `GET /api/me/calendar/series`. */
export const calendarSeriesListSchema = z.object({ items: z.array(calendarSeriesItemSchema) });
export type CalendarSeriesList = z.infer<typeof calendarSeriesListSchema>;

/**
 * Corpo di `PUT /api/me/calendar/series/:recurringEventId`: sostituisce
 * l'INTERA configurazione della serie (come `PUT /api/projects/:id/plugins`,
 * non una patch parziale — qui non c'è un client mobile che scrive questo
 * corpo, quindi non vale l'invariante "solo PATCH" di `me-prefs.ts`).
 * `accountId` è necessario perché `recurringEventId` da solo non è unico:
 * la stessa serie di due caselle diverse dello stesso utente avrebbe lo
 * stesso id lato Google.
 *
 * Il server rifiuta `enabled: true` senza `projectId`: design fase 7b §4,
 * "Il progetto si fissa, non si ri-deduce" — non esiste una serie accesa
 * senza un progetto.
 */
export const calendarSeriesPatchSchema = z.object({
  accountId: z.uuid(),
  enabled: z.boolean(),
  projectId: z.uuid().nullable(),
  action: calendarSeriesActionSchema.default("milestone"),
  leadDays: z.number().int().min(0).max(30).default(2),
  auto: z.boolean().default(false),
});
export type CalendarSeriesPatch = z.input<typeof calendarSeriesPatchSchema>;
