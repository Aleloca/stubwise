# Area 10 — Claude dentro l'app: inventario

> **Bozza**, 19 nov 2026, su richiesta di stubwise-46: inventario per
> l'integrazione dell'area 10 nell'app nuova (`apps/desktop`). Lato
> renderer: stubwise-94 (questa versione). Lato server: stubwise-72, da
> aggiungere. È solo un documento: qui non si prende nessuna decisione, e le
> domande stanno in fondo (D-n).
>
> Fonti:
> - il design `docs/plans/2026-11-02-desktop-area10-claude-integration-design.md`,
>   coi piani `…-area10a-plan.md` e `…-area10b-plan.md`;
> - nel prototipo: `apps/desktop/docs/area10-parity.md` (una riga per voce
>   nuova del 10a e del 10b, con file e test), `ossatura-follow-ups.md`
>   («Area 10a/10b — minori aperti», §12–§18) e le shape
>   `apps/desktop/.impeccable/shape/claude-*.md` e `task-delete.md`;
> - quello che è già integrato: `apps/desktop/docs/integration-claude-chat.md`
>   (la «Chat con Claude», fette 1–5, F3.4 e F5.4) e
>   `integration-area3{a..e}.md` (Claude come collega);
> - il registro dei rimandi (`docs/plans/integrazione-registro-rimandi.md`:
>   «Fase Chat con Claude e azioni», «Area 10», e le voci «Azioni di Claude»
>   delle aree 7, 8, 9 e 11);
> - il confronto fra i due cataloghi delle azioni: `ClaudeActionFn` del
>   prototipo (`data/claude/types.ts`, 51 funzioni) e `CLAUDE_ACTION_FNS` del
>   server (`packages/shared/src/schemas/claude-actions.ts`).
>
> **La premessa che cambia tutto rispetto all'area 9**: gran parte dell'area
> 10 è già nell'app. La fase «Chat con Claude e azioni» (10 nov 2026, fette
> 1–5) ha portato il riquadro, le conversazioni libere, le pubbliche e la
> continuazione, le classi A e B calcolate dal server, «Annulla», il segno
> «via Claude», «Elimina task» e le azioni della pagina. Quello che resta è
> soprattutto: le **azioni delle aree integrate dopo** (7, 9, 11), la
> **classe C**, gli **scenari del 10b** che chiedono letture o azioni nuove
> (S1–S5), le **bozze nei campi**, i **suggerimenti** e qualche lettura
> nuova.

## Le voci

Gli stessi titoli nei due lati:

1. Il riquadro e il contesto della pagina
2. Conversazioni: libere, pubbliche, continuazione
3. Le classi A–D e la conferma
4. Il catalogo delle azioni
5. «Annulla»
6. Il segno «via Claude» (registro, attività, notifiche, Chat)
7. «Elimina task»
8. Le notifiche nuove: `task.assigned` e `member.added`
9. S0, la risposta onesta
10. S1, un'automazione dal riquadro
11. S2 e S3, rispondere sui dati (progetti fermi, spesa del mese)
12. S4, archiviare in blocco
13. S5, aggiungere una persona a un progetto
14. Le bozze nei campi
15. Le azioni della pagina
16. «Claude può aiutarti a…» (suggerimenti)
17. «/», «#», «@», citazioni e allegati

## Lato server

> Di stubwise-72, da scrivere. Per ogni voce: cosa ha già il server (rotte,
> tool della chat, catalogo), le lacune e lo stato (**c'è**, **in parte**,
> **manca**).

## Lato renderer

> Di stubwise-94. Il dettaglio schermata per schermata del prototipo c'è già
> e non si ricopia: `apps/desktop/docs/area10-parity.md` (voce, file, test).
> Qui per ogni voce: cosa fa il prototipo, cosa fa oggi l'app, la lacuna.
> Stato, visto dal renderer: **c'è**, **in parte**, **manca**.

### 1. Il riquadro e il contesto della pagina — in parte

- **Prototipo**: ⌘J, il bottone del binario, ⌘K «Ask Claude…»; il chip del
  contesto per ogni oggetto che la pagina mostra (task, richiesta, pagina
  Docs, impostazioni, rilascio, PR, conversazione di supporto, automazione,
  email, server), riletto con la visibilità (`data/claude/context.ts`).
- **App** (`claude-panel` acceso): il riquadro è la conversazione libera; il
  chip c'è per task, richieste, pagine Docs e impostazioni di progetto. Al
  server va il CODICE, che il modello rilegge coi tool.
- **Lacune**:
  - nessun chip per gli oggetti delle aree integrate dopo la fetta 2 della
    chat: rilasci e PR (area 8), conversazioni di supporto, server,
    automazioni (area 7), email ed eventi (area 6), canali (area 4), file del
    Drive (area 5). Per ognuno serve anche un tool di lettura che il modello
    possa usare col codice (lato server);
  - le domande della doc di prodotto sotto il chip (`product-docs`): area 11.

### 2. Conversazioni: libere, pubbliche, continuazione — c'è

- Fette 1–5 della chat: «Mine», «Public», «Make public» con la conferma dei
  progetti, il seguito privato, «Continue». Niente da fare per l'area 10.
- Limiti già nel registro e accettati (ordine di «Public», prosa
  dell'originale con un tetto, codici nella prosa non collegati).

### 3. Le classi A–D e la conferma — in parte

- **Prototipo**: A parte subito, B chiede la conferma, C chiede la
  riconferma (la classe C viene SOLO da `REAUTH_REQUIRED`), D si rifiuta
  dicendo dove si fa (`domain/claude/intents/refused.ts`).
- **App**: A e B calcolate dal server con la prova a secco; D la dice il
  modello col contratto del prompt (golden `chat-never-catalog`).
- **Lacune**:
  - la **C** non esiste: le sei azioni C del prototipo (`addMember`,
    `removeMember`, `setMemberRole`, `registerPlugin`, `updatePluginRef`,
    `saveStorage`) sono tutte dell'area 9, quindi la C arriva con F7
    dell'area 9;
  - nel renderer, `confirmEdited` (la scheda «Edit») salta il `reauth()` che
    usa la conferma semplice: innocuo finché nessuna C ha «Edit», da chiudere
    con la prima C (registro, area 9).

### 4. Il catalogo delle azioni — in parte

Il confronto dei due cataloghi: 36 funzioni del prototipo non sono sul
server. Per area:

| Area | Funzioni del prototipo che il server non ha | Fetta che le porta |
|---|---|---|
| 7, automazioni | `createAutomation`, `saveAutomationDraft`, `deleteAutomationDraft`, `saveAutomation`, `saveProjectAutomations` | area 10 (S1, voce 10) |
| 9, membri e ruoli | `addMember`, `removeMember`, `setMemberRole` | F7 dell'area 9 |
| 9, progetto | `archiveProject`, `reopenProject`, `updateProjectGeneral`, `setProjectAi` | F7 dell'area 9 (archivia e riapri dopo F6) |
| 9, AI dell'istanza | `setModel`, `saveBudget`, `setProviderEnabled`, `moveProvider` | F7 dell'area 9 |
| 9, integrazioni | `registerPlugin`, `updatePluginRef`, `removePlugin`, `rerunSmoke`, `updateGitAccount`, `setDefaultReviewer`, `updateGoogleApp`, `saveStorage`, `setAttachments`, `updateWebhook` | F7 dell'area 9 |
| 9, stato dell'istanza | `pauseQueue`, `resumeQueue`, `retryJob` | F7 dell'area 9 |
| 11, doc di prodotto | `writeFirstVersion`, `undoFirstVersion`, `updateProductPage`, `undoProductUpdate`, `drawWireframe`, `deleteWireframe` | area 11 |

Le funzioni delle aree 2–6 e 8 del prototipo ci sono tutte (con `fillMailBody`
della Posta e `setSubscription` degli avvisi). Il renderer non cambia per
aggiungerne una: la scheda e la riga si derivano dalle viste del server
(F3.4). Serve solo la frase di ciascuna, che il prototipo ha già.

### 5. «Annulla» — c'è

- Dell'autore, una volta, se nessuno ha scritto dopo (`changed_after`);
  diventa una scheda B se gli inversi avviserebbero qualcuno.
- Limite nel registro: `changed_after` di richieste e filtri guarda solo
  `updated_at` e non dice chi.

### 6. Il segno «via Claude» — in parte

- **App**: c'è su storia della task, commenti, card d'inbox («Claude on
  behalf of …») e attività delle persone (derivato a lettura).
- **Lacune**:
  - il **registro delle modifiche**: «Made with Claude» (`?via=claude`) e la
    riga «Undid: …» sotto l'inversa restano spenti (`real/changelog.ts`
    risponde vuoto a `via: "claude"`, `undoOf: null`). Il registro li
    rimanda a F7 dell'area 9;
  - i messaggi «via Claude» nella Chat: `chat_messages.via_claude_action_id`
    resta inerte finché non c'è un'azione «scrivi nel canale» (registro,
    area 4).

### 7. «Elimina task» — c'è

- Fetta 3.0 della chat, a mano e come inverso di `createTask`. Limite nel
  registro: la cronologia del progetto non nomina le task eliminate.

### 8. Le notifiche nuove — in parte

- `task.assigned`: c'è (l'app la legge, `real/notifications.ts`).
- `member.added` *(D4 del 10b, maintainer)*: «You've been added to ACQ as
  Developer», a mano e da Claude per conto di qualcuno, mai per chi aggiunge
  sé stesso, con «Undone by …» derivato a lettura. **Manca** nell'app:
  serve un `notification_kind` nuovo sul server (con la regola di rollback)
  e la riga in `real/notifications.ts`. Va con i membri (F1 dell'area 9 li
  ha portati) o con F7.

### 9. S0, la risposta onesta — in parte

- **Prototipo**: una domanda non riconosciuta riceve l'elenco delle nove
  cose che Claude sa fare, ognuna con una frase d'esempio che un clic scrive
  nella casella (`CapabilitiesList.tsx`, evento `capabilities`).
- **App**: risponde il modello. Fuori portata dice che non può e dove si fa
  a mano; la riga di benvenuto `landing.intro` dice cosa sa fare.
- **Lacuna**: l'elenco cliccabile non esiste. Nel prototipo era un copione;
  nell'app andrebbe deciso chi lo produce (D-1).

### 10. S1, un'automazione dal riquadro — manca

- **Prototipo**: dalla pagina Support, «avvisa il reparto quando arriva una
  richiesta urgente»: la scheda di scelta del reparto, la bozza spenta e
  senza proprietario, la riga della prova («Wouldn't start» quando il filtro
  non passa, D3), il costruttore che si apre da sé dopo la prova (D2) con
  «Back to <pagina>».
- **App**: le automazioni sono integrate (area 7, F1–F4), ma Claude non ha
  le loro azioni (voce 4) né la prova (`trialAs`).
- **Lacune**:
  - le cinque azioni sulle automazioni nel catalogo del server, la prova
    senza effetti come azione e la scheda di scelta (`QuestionCard`):
    Claude oggi non fa domande a scelta nella chat libera (D-2);
  - nel renderer: la riga della prova (`TrialRow`) e l'apertura del
    costruttore dopo la prova, sulle viste del server;
  - i due dati nuovi di `request_created` (urgenza, dal supporto) e «Avvisa»
    un reparto: da verificare contro il motore vero dell'area 7 (lato
    server).

### 11. S2 e S3, rispondere sui dati — in parte

- **Prototipo**: S2 elenca i progetti fermi con un'ipotesi e «Details»,
  ristretto al progetto del contesto; S3 dice la spesa AI del mese a chi ha
  `usage.view`, e agli altri la somma dei soli loro progetti.
- **App**: risponde il modello con i sette tool di lettura (progetti,
  persone, cerca/leggi task, leggi richiesta, cerca docs, brief e registro
  decisioni). Nessun tool legge il lavoro fermo né i consumi.
- **Lacune**: due tool di lettura (lavoro fermo del progetto, spesa del mese
  coi permessi del server) e le loro rotte in `CHAT_TOOL_READ_ROUTES`; nel
  renderer «Hypothesis» e «Details» (`AsideRow`) restano del prototipo, a
  meno di una forma strutturata della risposta (D-3).

### 12. S4, archiviare in blocco — manca

- **Prototipo**: «Archivia i progetti senza attività da 3 mesi»: la scheda
  in blocco (5 righe e «Show N more»), le righe che chi chiede non può
  archiviare a parte col «Who?», le ragioni `busy` per progetto.
- **App**: dipende da F6 (archivio) e da F7 (le azioni) dell'area 9. Le
  ragioni `busy` hanno già la forma concordata con 72 per F6, compresa
  `doc_generation`; il renderer della scheda in blocco c'è nel prototipo.

### 13. S5, aggiungere una persona a un progetto — manca

- **Prototipo**: la scheda C con la riconferma, o bloccata dall'escalation
  (`escalation`, `target_above`) con la frase che lo dice.
- **App**: dipende dalla C e da `addMember` (F7 dell'area 9), più
  `member.added` (voce 8).

### 14. Le bozze nei campi — in parte

- **Prototipo**: una bozza di Claude in quattro campi (risposta di supporto,
  note di rilascio della PR, corpo dell'email, descrizione di una task), con
  la riga `draft` («Put it in the field», «Undo» solo a pagina aperta) e il
  segno unico «Bozza di Claude».
- **App**:
  - corpo dell'email: **c'è** (`mail-claude-draft`, `fillMailBody`);
  - note di rilascio: **in parte**. La bozza del server
    (`releaseNotesDraftFromServer`, dalla GET `…/release-notes`) è pronta ma
    non collegata al riquadro (registro, area 8);
  - descrizione di una task: **manca**;
  - risposta di supporto: **uscita** per la premessa corretta del maintainer
    (14 nov 2026, il team non scrive al cliente nel widget). Il prototipo va
    ancora riallineato (registro, area 8).
- **Lacuna**: una forma comune nell'app per «metti il testo nel campo»: oggi
  c'è solo per il corpo dell'email. Propongo la stessa via delle azioni della
  pagina, D3 (D-4).

### 15. Le azioni della pagina — c'è

- Filtro, filtro salvato, lingua, tema, con «Undo» (D3, F3.4): le esegue il
  renderer, solo se arrivano dal vivo in quella finestra.
- Limite nel registro: l'esito è in memoria, per persona. Dopo un
  ricaricamento la riga resta «non applicata» col gesto «Apply».

### 16. «Claude può aiutarti a…» — manca

- **Prototipo**: una riga discreta in cinque pagine, con «Not now» per
  oggetto e le regole del «mai se» (`data/claude/suggestions.ts`).
- **App**: `claude-suggestions` spenta.
- **Lacuna**: chi decide quando la riga si mostra. Nel prototipo la regola
  legge dati e permessi; nell'app il client non deve dedurre i permessi, e
  «Not now» va ricordato da qualche parte (D-5).

### 17. «/», «#», «@», citazioni e allegati — in parte

- **App**:
  - «/» ha `/explain`, `/docs` e i comandi d'azione (`/plan`, `/new-task`,
    `/new-request`, `/run`);
  - «#» propone task, progetti e pagine Docs; «@» le persone;
  - i codici nel testo si risolvono (`resolveCodes`).
- **Lacune**:
  - `/status` e `/today`: tornano quando i tool leggono progetti seguiti,
    decisioni e la settimana di chi scrive;
  - nessuna skill dei plugin del progetto in «/»;
  - «#» senza le richieste;
  - le citazioni registrate sui messaggi non esistono sul server, comprese
    quelle di file (`<repo>:<path>`), che aspettano un tool che legga il
    codice (area 5, D6);
  - nessun allegato nei messaggi (`claude-attachments` spenta).

### Cosa resta «Coming soon» nell'app

- **Funzioni spente dell'area 10**: `claude-suggestions` (voce 16),
  `claude-attachments` (voce 17), `product-docs` (voce 1, è dell'area 11).
- **Niente di spento, ma assente**:
  - le azioni del catalogo delle aree 7, 9 e 11 (voce 4): Claude dice che
    non può e dove si fa a mano;
  - la classe C (voce 3);
  - «Made with Claude» e «Undid» nel registro (voce 6);
  - `member.added` (voce 8);
  - la bozza della descrizione e delle note di rilascio (voce 14);
  - i chip delle aree 4–8 (voce 1).
- **Dipendono da altre fette**: S4 da F6 e F7 dell'area 9; S5 da F7; le
  domande della doc di prodotto dall'area 11.

### Le differenze di parità attese (dove il prototipo ha più del server, o diverso)

1. **Copione contro modello.** Nel prototipo S0–S6b sono scenari scritti
   (`domain/claude/intents/*`); nell'app risponde un modello vero coi tool.
   La parità non è «la stessa frase», ma «lo stesso esito, con le stesse
   regole» (permessi di chi chiede, R-G5, conferma). Gli scenari del 10b
   vanno riletti come golden del worker, non come test del renderer (D-6).
2. **Forme strutturate delle risposte**: «Hypothesis»/«Details» di S2, la
   scheda di scelta di S1, l'elenco cliccabile di S0. Nel prototipo sono
   eventi del copione (`aside`, `question`, `capabilities`); nell'app il
   modello scrive prosa, salvo i tool che producono eventi (oggi solo
   `propose_action`).
3. **Le domande di Claude nella chat libera**: il prototipo le fa (S1,
   `QuestionCard`); nell'app `ask_user` esiste solo nei run del worker, non
   nella chat.
4. **I chip delle aree integrate dopo**: il prototipo ne ha per ogni
   oggetto, l'app per quattro tipi.
5. **Le bozze**: una forma sola nel prototipo (`fillable.ts`), una sola via
   nell'app (`fillMailBody`).
6. **Il registro delle modifiche** senza il segno di Claude (voce 6), con
   F7 dell'area 9.
7. **Fuori per decisione del maintainer**: la bozza di risposta di supporto
   e «Chiedi a Claude» nel Supporto (premessa del 14 nov 2026).

### Cosa cambiano nel renderer le risposte del lato server

- **Un'azione nuova nel catalogo** (aree 7, 9, 11): nessun componente nuovo.
  La scheda e la riga si derivano dalle viste; serve la frase della riga
  `executed` e, per le C, il passaggio dalla riconferma anche per
  `confirmEdited`.
- **Un tool di lettura nuovo** (S2, S3, i chip delle aree 4–8): nel renderer
  cambia solo il contesto che il chip manda (il codice o l'id dell'oggetto)
  e, per i chip, la rilettura con la visibilità come per task e richieste.
- **Un evento strutturato nuovo** (domanda a scelta, «Details», elenco di
  S0): un evento della sessione col suo schema additivo. Il renderer ha già
  i componenti, va solo letto dallo stream (`real/claudeStream.ts`) come
  `proposal`.
- **«Metti nel campo»** come azione della pagina: il renderer la esegue come
  le altre D3. Con D-4 = a, la descrizione della task e le note di rilascio
  riusano `fillable.ts` del prototipo.

### Le fette viste dal renderer

- **F1 — il contesto e le bozze**: i chip delle aree 4–8 con i loro tool di
  lettura; le bozze della descrizione e delle note di rilascio come azioni
  della pagina. Poco server per tipo, molto renderer già scritto.
- **F2 — S1, le automazioni dal riquadro**: le cinque azioni, la prova come
  azione e la domanda a scelta. È la fetta più larga lato server (D-2).
- **F3 — S2 e S3**: due tool di lettura e, se D-3 = a, l'evento «Details».
- **F4 — S0 e i suggerimenti**: l'elenco cliccabile (D-1) e la riga «Claude
  può aiutarti a…» (D-5).
- **Con l'area 9**: la C, S4, S5, `member.added` e «Made with Claude» stanno
  in F6/F7 dell'area 9 e non si rifanno qui.
- **Con l'area 11**: le azioni della doc di prodotto e `product-docs`.
- **Allegati** (`claude-attachments`): a parte, quando il server li accetta.

## [DECIDE]

> Proposte del renderer; 72 aggiunge le sue.

- **D-1 — S0, l'elenco di ciò che Claude sa fare.**
  - (a) un evento `capabilities` che il server produce quando il modello non
    riconosce la richiesta, con l'elenco dal catalogo vero (le azioni che chi
    chiede può fare): il renderer ha già `CapabilitiesList`;
  - (b) nessun elenco: risponde il modello, come oggi.
- **D-2 — Le domande di Claude nella chat libera (S1).**
  - (a) un tool `ask_choice` della chat, con la scheda di scelta del
    prototipo e la risposta che torna come messaggio della persona;
  - (b) niente scheda: il modello chiede in prosa e la persona risponde
    scrivendo.
- **D-3 — Le risposte strutturate di S2 («Hypothesis» e «Details»).**
  - (a) un evento `aside` dal tool di lettura del lavoro fermo;
  - (b) prosa del modello, senza la riga «Details».
- **D-4 — Le bozze nei campi.**
  - (a) come le azioni della pagina (D3): un `pageAction` «riempi il campo»
    che il renderer esegue solo dal vivo, col segno «Bozza di Claude», per
    descrizione della task e note di rilascio. È la via di `fillMailBody`;
  - (b) una rotta per campo sul server.
- **D-5 — «Claude può aiutarti a…».**
  - (a) il server dice quali suggerimenti valgono per chi guarda (con le
    regole del «mai se»), e «Not now» si salva per persona sul server;
  - (b) la regola resta nel renderer sui dati che legge, con «Not now» in
    locale. È più semplice, ma il client deduce cose che dipendono dai
    permessi.
- **D-6 — Dove si prova la parità degli scenari.**
  - (a) gli scenari S1–S5 diventano golden del worker (come `chat-*`), coi
    dati del seme in una fixture: la parità si misura sull'esito;
  - (b) restano test del renderer sul prototipo, e l'app si prova a mano.
