// L'allowlist del token del turno della chat con Claude, in UN posto (area 8,
// F1, 13 nov 2026): la usano il server (`apps/server/src/auth/
// chat-tool-routes.ts`, che la ri-esporta) e il golden della chat
// (`apps/worker/scripts/golden/run.ts`), che prima ne teneva una copia
// rimasta indietro due volte (`read_doc_page`, `read_release`).

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
  // Area 8, F1: un rilascio per codice (tool `read_release`, «Spiega»), coi
  // progetti che l'autore vede (404 agli altri, come la rotta).
  "/api/releases/:code",
  // Area 9, F7 (`read_project_members`): membri e ruoli che si possono scegliere in un
  // progetto, per chi lo vede (`member`, come la rotta). Il ponte toglie le email.
  "/api/projects/:projectId/members/view",
  // Area 9, F7 (`read_instance_settings`): le impostazioni d'istanza, ognuna
  // col SUO permesso d'istanza (403 agli altri). Il ponte passa al modello
  // solo i campi in allowlist: niente segreti, niente ultime cifre, niente url
  // dei webhook.
  "/api/ai-providers",
  "/api/git-accounts",
  "/api/settings/google-workspaces",
  "/api/settings/webhooks",
  "/api/plugins",
  "/api/settings/models",
  "/api/settings/automation",
  "/api/settings/instance",
  // Area 10, F1 (`read_automation`): un'automazione per codice, con la
  // visibilità della rotta (404 a chi non vede il progetto). Il ponte passa al
  // modello solo i campi in allowlist: niente destinatari né corpo delle email,
  // niente casella, niente evento delle esecuzioni.
  "/api/automations/:code",
  // Area 10, F1 (`read_server`): un server del monitoraggio per codice, per chi
  // lo vede. Il ponte toglie il `target` dei check (per i DSN è la stringa del
  // database) e il loro `lastError`.
  "/api/servers/by-code/:code",
  // Area 10, F1 (`read_support_conversation`, `read_channel`): contenuto NON
  // fidato, anche in `CHAT_TOOL_UNTRUSTED_ROUTES` del server. La conversazione
  // con la visibilità del progetto; il canale con le regole della Chat (un
  // privato di cui non si è membri è 404).
  "/api/support/conversations/by-code/:code",
  "/api/chat/channels/:id",
  "/api/chat/channels/:id/messages",
  // Area 10, F1 (`read_mail_thread`, `read_calendar_event`): la posta e il
  // calendario di CHI CHIEDE — le rotte leggono con l'id dell'utente, e un
  // admin che chiede quelli di un altro riceve 404 (`mailbox_owner`).
  // Contenuto NON fidato: anche in `CHAT_TOOL_UNTRUSTED_ROUTES`.
  "/api/me/mail/threads/:threadId",
  "/api/me/calendar/events/:id",
  // Area 10, F2 (`list_departments`, S1): i reparti dell'istanza, per chi
  // chiede. Il ponte passa solo id, nome e se è il reparto di ripiego.
  "/api/departments",
  // Area 10, F3 (`read_stalled_work`, S2): le task FERME con le soglie dei
  // progetti, la stessa regola e la stessa rotta della lista delle task
  // (`stallOf`, decisione del maintainer, 20 nov 2026). Il ponte non passa i
  // titoli né le note (possono venire da fuori), solo codici, date e motivi.
  "/api/tasks/stalled",
  // Area 10, F3 (`read_usage_month`, S3, D-13 = a): la spesa del mese coi
  // permessi di chi chiede (tutta l'istanza con `usage.view`, i soli progetti
  // con `project.usage.view`, 403 senza) e, per chi non può vederla, chi può
  // dirglielo (`usage.view`): il ponte passa solo i nomi.
  "/api/ai-usage/summary",
  "/api/access/who-can",
  // Area 10, F4 (`read_archive_candidates`, S4): i progetti fermi di chi chiede,
  // divisi come nel prototipo. Il ponte non passa i titoli dei motivi `busy`.
  "/api/projects/archive-candidates",
  // Area 10, F8 (`read_my_week`, «/today»): le decisioni che aspettano chi
  // chiede (`askedOfId=me`) e le sue task (`assigneeIds=me` di `/api/tasks`).
  // Solo il GET dell'elenco: `/api/decisions/:id/answer` è una scrittura e
  // NON sta qui.
  "/api/decisions",
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

/**
 * Il percorso concreto di una richiesta combacia con una rotta registrata di
 * Fastify (`/api/releases/:code`)? Ogni `:param` è un segmento non vuoto.
 */
export function chatRoutePattern(route: string): RegExp {
  const escaped = route
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${escaped}$`);
}
