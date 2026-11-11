/**
 * L'allowlist CHIUSA delle rotte che il token del turno della chat con Claude
 * (chat, fetta 1) può chiamare: SOLO GET di lettura, quelle che i tool di
 * Claude usano, con la visibilità dell'autore della conversazione. Ogni altra
 * rotta — anche una GET — risponde 403 `chat_tool_forbidden`. Le chiavi sono
 * gli URL registrati di Fastify (`routeOptions.url`). Il test di registro
 * (`chat-tool-token.test.ts`) verifica che ogni voce sia una GET registrata,
 * autenticata, senza riconferma né porta di credenziale.
 *
 * Chi aggiunge una rotta qui la aggiunge perché un tool di lettura la usa, e
 * MAI una che scrive, che dà un token o che legge segreti.
 */
export const CHAT_TOOL_READ_ROUTES: ReadonlySet<string> = new Set([
  // Elenca i progetti (quelli che l'autore vede).
  "/api/projects",
  // Le persone che l'autore vede (fetta 3: per proporre un assegnatario per
  // nome). Il ponte ne passa al modello solo id, nome, iniziali e reparti:
  // le email restano fuori.
  "/api/people",
  // Cerca le task (filtri e testo), leggi una task per codice.
  "/api/tasks",
  "/api/tasks/by-code/:code",
  // Leggi una richiesta per codice.
  "/api/requests/by-code/:code",
  // Cerca nella documentazione di un progetto.
  "/api/projects/:projectId/docs/search",
  // Leggi una pagina Docs intera (area 5, fetta 1: tool `read_doc_page`), con
  // `docs.view` nel progetto del repository, come la rotta.
  "/api/repositories/:repositoryId/docs/pages/:slug",
  // L'Overview: l'ultimo brief e il registro decisioni (in lettura).
  "/api/projects/:projectId/briefs/latest",
  "/api/projects/:projectId/decisions",
  // Il Drive (area 5, fetta 3: `search_drive` e `read_drive_file`), coi file
  // dei progetti di cui l'autore è membro. Leggere il contenuto non conta
  // un'apertura.
  "/api/projects/:projectId/drive/files",
  "/api/drive/files/by-code/:code/content",
]);

/**
 * Le rotte di lettura che consegnano a Claude contenuto NON fidato, scritto da
 * altri (area 5, fetta 3, decisione O): il testo di un file del Drive (anche
 * nello snippet di una ricerca) e le pagine Docs, intere o negli snippet della
 * ricerca (le manuali le scrive chiunque abbia `docs.edit`). Una lettura RIUSCITA del token del turno su una
 * di queste segna la conversazione (`claude_conversations.untrusted_read_at`),
 * e da lì ogni proposta è almeno B (`claude-actions/proposals.ts`). Chi
 * aggiunge un tool che legge testo scritto da altri aggiunge qui la sua rotta.
 */
export const CHAT_TOOL_UNTRUSTED_ROUTES: ReadonlySet<string> = new Set([
  "/api/projects/:projectId/drive/files",
  "/api/drive/files/by-code/:code/content",
  "/api/repositories/:repositoryId/docs/pages/:slug",
  // Gli snippet della ricerca nei Docs: righe delle stesse pagine (decisione (a), 11 nov 2026).
  "/api/projects/:projectId/docs/search",
]);

/**
 * La sola rotta di SCRITTURA del token del turno (chat, fetta 3; decisione D2
 * dell'orchestratrice, 10 nov 2026): creare una PROPOSTA di Claude (tool
 * `propose_action`). Non esegue niente da sé: la classe la calcola il server
 * sui dati veri, una A la esegue il server a nome della persona, una B
 * aspetta la conferma dell'autore (mai col token del turno). Una voce sola,
 * col suo test di registro: chi ne aggiunge un'altra cambia la condizione 2
 * di `docs/invariants/second-factor.md`, non solo questo file.
 */
export const CHAT_TOOL_WRITE_ROUTES: ReadonlySet<string> = new Set(["POST /api/claude/conversations/:id/proposals"]);
