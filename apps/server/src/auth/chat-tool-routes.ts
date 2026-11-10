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
  // L'Overview: l'ultimo brief e il registro decisioni (in lettura).
  "/api/projects/:projectId/briefs/latest",
  "/api/projects/:projectId/decisions",
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
