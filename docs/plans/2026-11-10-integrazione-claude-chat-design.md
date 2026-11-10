# Integrazione: la chat con Claude e le sue azioni — design

Data: 10 nov 2026. Fase subito dopo l'area 3 *(maintainer: «prima il lavoro,
chat dopo»)*, insieme alle azioni di Claude dell'area 10. Valgono architettura e
regole dell'integrazione delle aree 2 e 3. Specifica: il prototipo —
`docs/plans/2026-10-24-desktop-area3-claude-design.md` §2 e §5,
`docs/plans/2026-11-02-desktop-area10-claude-integration-design.md`,
`apps/desktop/docs/{area3,area10}-parity.md`, gli shape `claude-*`, e
`apps/desktop/src/renderer/{pages/claude,layout/claudePanel,data/claude,domain/claude}`.

## Cosa entra (prima versione)

- **Conversazioni libere private** con Claude: destinazione Claude («New
  conversation», N), riquadro (⌘J, ⌘K «Ask Claude…»), titolo, rinomina,
  archivia, elimina, chip del contesto della pagina, citazioni e menzioni sui
  dati veri, «/» con i comandi e le skill del progetto del contesto, «Ferma».
- **Proposte e azioni** sulle aree già integrate *(maintainer)*: task (crea,
  modifica, pianifica), commenti, richieste (crea, trasforma, archivia, riapri),
  traguardi, filtri, avvio del lavoro di Claude, azioni della pagina (filtro,
  lingua, tema).
- **Classi come il prototipo** *(maintainer)*: A parte subito con «Annulla»
  (solo tua, nessun avviso, nessuna automazione), B scheda Conferma / Modifica
  / Annulla, C scheda più riconferma (mai con un PAT), D non si esegue e porta
  al gesto vero. **La classe la calcola il server** sui dati veri al momento,
  può solo salire; il modello non la decide.
- **Fuori portata** *(maintainer)*: Claude risponde liberamente con i dati che
  può leggere per conto di chi scrive; a una richiesta di FARE qualcosa che non è
  nel catalogo dice chiaramente che non può e indica dove si fa a mano (niente
  elenco fisso come la «risposta onesta» del prototipo).
- Segno **«Claude per conto di X»** su ogni scrittura (registro modifiche,
  attività, commenti, notifiche), `actorId` resta la persona; **«Annulla»** come
  scrittura inversa, solo di chi ha chiesto e solo se nessuno ha scritto dopo,
  con il permesso ricontrollato.
- Budget mensile e consumi come gli altri run (`UsageTag`, `TrackingAgentRunner`);
  con la quota finita la casella si spegne.

## Dopo, in fette a sé

- **Conversazioni pubbliche e continuazione** *(maintainer: dopo)*, con
  `claude.public.view`, conferma dei progetti letti, messaggi privati se Claude
  tocca un progetto nuovo. Fetta 5, piano
  `docs/plans/2026-11-10-integrazione-claude-chat-f5-plan.md`. **Decisione del
  maintainer (10 nov 2026, D1): gli eventi dei tool di una pubblica RESTANO
  visibili ai lettori.** Esempio confermato: i dati del progetto X letti da
  Claude per l'autore (il `tool_result` del token del turno) li vede chi legge
  la pubblica. La difesa è la conferma esplicita alla pubblicazione, che lo
  dice (`includesToolReads`), e il seguito privato. Non va «corretta»
  togliendo i tool ai lettori.
- Le azioni delle aree non ancora integrate (posta 6, automazioni 7, rilasci,
  avvisi e assistenza 8, amministrazione 9, documentazione di prodotto 11) e le
  **bozze nei campi** *(orchestratrice: con le loro aree)*.
- «Elimina task» (il server non la ha; entra con l'area che la definisce).

## Architettura *(orchestratrice)*

- **Sessione `free`**: le conversazioni sono `agent_sessions` di un kind nuovo,
  a turni (come il refinement, `TURN_BASED_SESSION_KINDS`), con eventi, input e
  stream già esistenti (SSE, cursore, IPC del desktop). Tabelle in più solo per
  ciò che le sessioni non hanno: titolo, archivio, contesto, proposte, gruppi
  eseguiti con l'inverso.
- **Runner conversazionale** nuovo nel worker, con **tool MCP propri** in un
  server MCP **senza DB né credenziali** (come `stubwise_refine`): letture con
  le viste delle pagine e la visibilità di chi scrive (passano dal server con
  l'identità della persona), e **«proponi azione»**, che scrive una proposta e
  non esegue niente. Nessun tool di scrittura diretta.
- **L'esecuzione la fa il server**: subito per A, alla conferma per B/C, con i
  permessi della persona ricontrollati in quel momento, usando gli stessi
  servizi delle rotte (mai una via parallela).
- **Mai nel catalogo** (verificato sul sorgente del server, come
  `neverInCatalog` del prototipo): approvare, rifiutare, pre-approvare o
  revocare un piano; rispondere a un `ask_user`; mergiare, rilasciare, fare
  deploy; scrivere nel registro decisioni (`decisions-never-ai.test` esteso ai
  moduli nuovi); leggere o mostrare segreti; inviare fuori (posta, webhook).
- **Lingua**: le righe di sistema di Claude (proposte, esiti, «Annulla») sono
  chiavi i18n con parametri, nella lingua di chi legge; il testo del modello
  resta testo.
- Golden nuovi per il runner (conversazione, proposta, nessuna esecuzione senza
  conferma, rifiuto delle azioni «mai nel catalogo»), sul CLI pinnato.

## Fette

1. **Server**: sessione `free`, runner a turni con i soli tool di lettura,
   budget, titolo/archivio/elimina, stream riusato.
2. **Renderer**: destinazione Claude e riquadro con la chat vera (Mine, New,
   ⌘J/⌘K, contesto, citazioni, menzioni, «/»).
3. **Server + renderer**: proposte e azioni A/B sulle aree 2–3, esecuzione,
   segno via, «Annulla».
4. Le C (riconferma) sulle stesse azioni, dove servono.
5. Pubbliche e continuazione.

## Verifica

Come le aree 2–3, più i golden del runner nuovo e il test «mai nel catalogo».
