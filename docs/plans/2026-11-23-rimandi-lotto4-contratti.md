# Rimandi, lotto 4: i contratti per il server

*23 nov 2026, 94 (renderer), su richiesta di 46.* Le voci di questo lotto
chiedono PRIMA il server. Per ognuna: cosa fa il prototipo (la specifica),
cosa c'è oggi nell'adattatore e nel server, e la forma esatta che il renderer
si aspetta, così 72 la implementa senza andare avanti e indietro.

Le voci vengono da `docs/plans/integrazione-registro-rimandi.md`; i numeri
«r.» della richiesta sono righe del registro, ritrovate per contenuto:

| § | Area | Voce | Registro |
|---|---|---|---|
| 1 | A8 | Lo stato «scartata» di una correzione | r.771-773 |
| 2 | A6 | La card per chi riceve una proposta passata | r.450-453 |
| 3 | A6 | Le richieste nate da una riunione | r.520-524, r.605-609 |
| 4 | A6 | Il badge delle proposte di riunione nell'elenco | r.528-531 |
| 5 | A6 | «Riprova» per un `fillMailBody` non salvato | r.371-373 |
| 6 | A6 | Il ritorno OAuth con `stubwise://google` | r.438-441 |
| 7 | A3 | Sessioni di Claude e report (avvio e risposte, piano e digest, `usage`/`blocked`, `generatedAt`) | r.33-42 |

Regole comuni a tutte le sezioni:
- verso i client solo cambi ADDITIVI: ogni campo nuovo in una risposta nasce
  `.default()`/`.optional()`/`.nullable()`, e il renderer ha un test con una
  fixture SENZA il campo (server di prima);
- il client legge i permessi calcolati dal server, non li deduce;
- una persona che chi guarda non conosce arriva `hidden-<n>` col nome null
  (r.1414);
- i campi di una card d'inbox si derivano a lettura, non si scrivono
  nell'evento, se sono derivabili;
- un `notification_kind` nuovo rende non sicuro scendere d'immagine sul
  server: nessuna sezione ne aggiunge.

## I «da decidere», tutti insieme

Ogni sezione li argomenta; qui c'è solo la raccomandazione di 94.

**Decisi il 23 nov 2026** (46; D-2.0 e D-7.1 dal maintainer):
- **D-2.0 = sì**, ma diverso dalla raccomandazione: una NOTIFICA (push
  compresa) a chi riceve una proposta passata, che compare anche nel pannello
  del desktop e apre la Home; in «Da decidere» la proposta resta. Fatta prima
  nel prototipo (d3e1fe9fb); il §2 è aggiornato.
- **D-7.1 = (b)**: a budget mensile finito si ferma anche l'avvio a mano (la
  regola del prototipo); il server si allinea (`blocked.monthly_budget` in
  `/work` e il rifiuto dell'avvio). Nel prototipo vale già in ogni punto di
  avvio a mano: le sessioni delle task (`aiStartBlock`, sei chiamanti, e
  `servers/fix.ts`), «Chiedi a Claude» (`api-mutations.ts:2333`), «Chiedi
  modifiche» su una PR (`releases/writes.ts:362`), l'analisi a mano di un
  server (`servers/analysis.ts:416`), la prima versione e le bozze di
  schermata della doc (`productDocs/firstVersion.ts:354`,
  `wireframes.ts:195`), «aggiorna da questa fonte» (`catalogProduct.ts:135`).
  Le automazioni, che non sono avvii a mano, restano in attesa.
- **D-5.0, D-1.2** e tutti gli altri: la raccomandazione di 94.

| Id | Voce | Domanda | Consiglio |
|---|---|---|---|
| D-1.1 | §1 | Il nome in «{{name}} pushed first»: il server non conosce l'autore | (a) testi senza nome nella build app |
| D-1.2 | §1 | Una scartata conta nel tetto vero (`autoRoundsInCurrentSeries`)? | (a) no, come il prototipo |
| D-1.3 | §1 | La notifica `job.failed` su una scartata | (a) non toccarla qui, va nel registro |
| D-2.0 | §2 | Farla, la card? Il prototipo non ce l'ha | (a) sì, fuori dal pannello del desktop |
| D-2.A | §2 | Legame card → proposta | (a) `event->>'proposalId'` più l'audience della riga, nessuna migrazione |
| D-2.B | §2 | La card nel pannello del desktop | (b) compare e apre Home finché c'è il web vecchio, poi (a) |
| D-2.C | §2 | Chi ottiene i permessi dopo il passaggio | (a) limite accettato |
| D-3.1 | §3 | Una richiesta ancora in intake | (b) esce con `pending: true`, senza link |
| D-3.2 | §3 | Una richiesta fusa a mano | (a) la sorgente, «Done», come il prototipo |
| D-3.3 | §3 | Visibilità delle task nelle righe | (b) `visibleTasksCondition` a tutte |
| D-3.4 | §3 | Il full admin non membro passa il cancello di `tasksOf` | da segnalare, fuori voce |
| D-5.0 | §5 | Il prototipo non ha `fillMailBody`: la scheda della build app è l'unica specifica | si fa, con i testi nuovi (D-5.1) |
| D-5.1 | §5 | Testi del «Riprova» | (a) chiavi nuove `retrySave`, `retryFailed.*` |
| D-5.2 | §5 | Bozza cambiata dalla persona prima del riprova | (b) 409 `draft_changed` |
| D-5.3 | §5 | Come si indica l'azione | (a) per indice nel gruppo |
| D-6.1 | §6 | Dove porta il callback | (a) una pagina dell'istanza, come il login |
| D-6.2 | §6 | Consenso annullato su Google | (a) resta `error` |
| D-7.1 | §7 | `monthly_budget` in `blocked` (oggi un avvio a mano scavalca il budget) | (a) il server non lo manda; (b) va registrato come decisione di prodotto |
| D-7.2 | §7 | `costUsd` di un CLI vecchio senza costo | (a) `null`, il renderer lo conta 0 |

Fuori voce, emersi leggendo (da mettere nel registro):
- §6: oggi in Preferenze → Account (`real/meMailboxes.ts`) ogni errore del
  collegamento diventa `failed`, quindi sul desktop `wrong_domain`,
  `scopes_missing` e `owned_by_other` non arrivano mai al dialogo (lo chiude
  il §6);
- §6: il registro dice «rilegge al ritorno in primo piano», mentre
  `connectGoogle` fa un polling a 3 s;
- §2: dopo il passaggio la card di chi passa resta `open` sul server, mentre il
  prototipo la toglie da «Da decidere»;
- §2: nel worker non c'è un percorso che chiuda le card delle proposte
  condivise quando il thread le supera;
- §4: anche il conteggio di oggi (`mail_recipients`) non controlla che il
  progetto sia ancora visibile;
- §7: gli autori degli interventi in una sessione (`inputs[].authorName`)
  escono come email, senza maschera;
- §7: chi ha deciso il piano e le sue istruzioni non arrivano da nessuna rotta.

## 1. A8 — Lo stato «scartata» di una correzione

Voce: `docs/plans/integrazione-registro-rimandi.md:771-773` (F1, S8, rimando (b)).

### Cosa fa il prototipo

- **Modello.** `PrAutoCorrection.state: "running" | "pushed" | "discarded" | "stopped"`. `discarded` = «l'autore ha spinto nel frattempo (non conta nel tetto)», `stopped` = «fermata prima del push» (`apps/desktop/src/renderer/data/model.ts:3281-3297`). Le correzioni esistono solo sulle PR dei colleghi (`model.ts:3323`). Sulle PR di Stubwise valgono le sessioni della task, quindi nel prototipo una PR di Stubwise non è mai «scartata».
- **Quando nasce.** `settleCorrection`: al momento del push, se `pr.headSha !== c.fromSha` la correzione diventa `discarded`, senza commit e senza alert (`data/releases/simulate.ts:149-160`). «Simula push dell'autore» scarta la correzione in volo e fa ripartire l'analisi sulla testa nuova (`simulate.ts:119-143`).
- **Stato della PR.** È lo stesso motore anche sul server: `prStateOf` (`packages/shared/src/releases/pr-state.ts:112-146`).
  - Una scartata non conta nel tetto (`countedRound`, `packages/shared/src/claude/pr-corrections.ts:28-29`).
  - Se ci sono problemi aperti, il ramo è correggibile e il tetto non è raggiunto, e l'ultima correzione è `discarded`, lo stato è `discarded` con `canAutoCorrect: true` (`pr-state.ts:145`).
  - Se dopo lo scarto non ci sono problemi, lo stato è `clean`, non `corrected` (`pr-state.ts:135-139`).
  - Mentre la testa nuova è in analisi, lo stato è `analyzing` (`pr-state.ts:131`).
  - `discarded` non è in `OPEN_PROBLEMS`, ma la PR non è pronta lo stesso, perché `analysis.issues` non è vuoto (`pr-state.ts:149-177`).
- **Testi** (`apps/desktop/src/renderer/i18n/locales/en.json`):
  - parola di stato `releases.prState.discarded` = «Correction discarded» (`:9023`), letta da `prStateWord` (`pages/releases/format.ts:94-100`) e dal filtro per stato (`pages/releases/PrList.tsx:245`);
  - seconda riga `releases.prLine.discarded` = «{{name}} pushed new commits first · analysing the new head» (`:9053`), con `name = pr.authorName` (`format.ts:145-146`);
  - riga della correzione nel pannello `releases.panel.correction.discarded` = «discarded: {{name}} pushed first · doesn't count» (`:9292`), in `PrPanel.tsx:150-161`, con `c.why` sotto se non è vuoto (`PrPanel.tsx:162-164`);
  - glifo: una barra obliqua `text-ink-faint` (`pages/releases/glyphs.tsx:45-49`).
- **Azioni.** Lo stato «scartata» non ha un'azione sua: niente «Riprova», nessuna stringa e nessun bottone trovati. Riparte da sola la correzione automatica (`canAutoCorrect: true`). Resta «Chiedi modifiche» sotto i permessi già esistenti.
- **`why` nel seme.** È il problema che la correzione affronta (es. `data/seed/releases/prs.ts:107`), non un errore.

### Cosa c'è oggi

- **Worker.** Il push è sempre in avanti (invariante «Una correzione non forza MAI il push», `docs/invariants/pr-corrections.md:152-158`). Un rifiuto è `PushRejectedError` (`apps/worker/src/git/mirrors.ts:266`). `handleNoPush` lo chiude con `fail(log, "push rifiutato: qualcuno ha pushato sul branch <b> durante la correzione")` (`apps/worker/src/pipeline/correction.ts:1469-1473`).
  - Nella stessa transazione: `ai_jobs.status = 'failed'` e `error` = quella frase (`apps/worker/src/queue.ts:238-251`), e `pr_corrections.status = 'done'` (`closeJobAndCorrection`, `correction.ts:604-635`; `completeCorrection`, `packages/notifications/src/pr-correction-cycle.ts:723-730`).
  - Poi partono `notifyJobFailed` e la review della testa attuale (`correction.ts:1329-1343`).
  - Non c'è un esito distinto: `pr_corrections` ha solo `status ∈ pending|queued|done|cancelled` (CHECK, `packages/db/src/schema.ts:2539-2587`).
- **Server.** `GET /api/projects/:projectId/pulls` → `listOpenPulls` (`apps/server/src/services/pulls.ts:21-232`).
  - Mappa ogni correzione `done` su `pushed` se `ai_jobs.status = 'pr_opened'`, altrimenti su `stopped`, sia per l'input di `prStateOf` (`pulls.ts:119-124`) sia per `correctionHistory` (`pulls.ts:197-208`, con `why` = `ai_jobs.error` sulle `stopped`).
  - Di conseguenza una scartata arriva come `stopped`, con `why` = «push rifiutato: …». `prState` non è mai `discarded`, e con problemi aperti esce `issues`.
- **Forma.** `OpenPull` è un'interfaccia TS (`packages/shared/src/releases/views.ts:90-163`). Ha già `correctionHistory[].state: "running" | "pushed" | "discarded" | "stopped"` (`views.ts:148`, commento «`discarded` non si deriva ancora») e `prState?: OpenPrState`, con `PrStateKind` che include già `discarded`. `client.releases.pulls` non parsa la risposta: niente Zod né `readerSchema` su questa rotta (`packages/api-client/src/endpoints/releases.ts:42-44`). L'unico lettore è il desktop (`data/backend/real/releasePrs.ts`, `releasesLive.ts`): web e app non chiamano `/pulls`.
- **Adattatore.** Copia `c.state` così com'è e `why: c.why ?? ""` (`data/backend/real/releasePrs.ts:156-167`), e `prState` dal server (`:172`). `authorName` è `"Claude"` sulle PR di Stubwise e `""` su quelle dei colleghi (`releasePrs.ts:131`).
- **Tetto vero (divergenza già presente).** Il cancello del server `autoRoundsInCurrentSeries` conta tutte le correzioni `trigger = 'review'` non annullate dopo l'ultima richiesta umana, quindi anche quelle fallite o rifiutate (`pr-correction-cycle.ts:80-108`). `countedRound`, che il renderer mostra («{{used}} of {{cap}}»), invece non le conta.

### Contratto

**Rotta.** `GET /api/projects/:projectId/pulls`: la forma non cambia. Nessun campo nuovo nella risposta: il valore `discarded` è già nel tipo.

| Campo | Oggi | Dopo |
|---|---|---|
| `correctionHistory[].state` | mai `discarded` | `"discarded"` quando la correzione è finita per push rifiutato |
| `correctionHistory[].why` | errore del job sulle `stopped` | `null` sulle `discarded` (il motivo lo dice già lo stato); invariato sulle altre |
| `correctionHistory[].commitSha` | `null` | `null` (una scartata non ha commit) |
| `prState` | calcolato senza scartate | `prStateOf` riceve `{ trigger, state: "discarded" }`, quindi può uscire `state: "discarded"` (con `canAutoCorrect: true`) o `clean` al posto di `corrected` |
| `corrections.lastStatus` | `pr_corrections.status` | invariato (`"done"`) |
| `ready` | — | invariato nella regola (`isReadyForRelease`) |

**Client vecchi.** Nessun rischio: `discarded` è già nell'unione di `OpenPull`, e la build desktop già distribuita lo sa mostrare (glifo, testi). Non serve `readerSchema` perché la rotta non viene parsata.

**Derivazione lato server: esito distinto della correzione.**
- **Migrazione additiva** (prossimo numero libero, oggi `0220`): `ALTER TABLE pr_corrections ADD COLUMN outcome text NULL` più `CHECK (outcome IS NULL OR outcome IN ('pushed','discarded','stopped'))`. Si usa un CHECK e non un pgEnum, come gli altri campi della tabella (`schema.ts:2537`): un solo batch e nessun problema di `ADD VALUE`.
- **Scrittura (worker).** `completeCorrection(tx, id, outcome)` scrive `outcome` nello stesso UPDATE guardato che porta la riga a `done`, cioè dentro `closeJobAndCorrection`. Così resta vera l'invariante «Job e correzione si chiudono INSIEME».
  - `PushRejectedError` → `'discarded'`;
  - chiusura col push (`finishPushed`, `keepIfCancelled`, «errore dopo il push… proseguo come riuscita») → `'pushed'`;
  - ogni altra chiusura `fail`/`complete` che porta a `done` → `'stopped'`.
  - Le `cancelled` restano senza esito e fuori dalla lettura, come oggi.
  - `reconcileOrphanCorrections` (le orfane chiuse dal tick) scrive `'stopped'`.
- **Il job non cambia.** `ai_jobs.status` resta `failed`, `error` resta la frase di oggi, la notifica `job.failed` resta.
- **Lettura (`pulls.ts`, entrambi i punti 119-124 e 197-208).** Lo stato è `outcome` se non è nullo, altrimenti la derivazione di oggi (`pr_opened` → `pushed`, altro → `stopped`) per le righe precedenti alla migrazione. `why` è `null` quando lo stato è `discarded`.
- **Backfill** (nella stessa migrazione, statement a sé): `UPDATE pr_corrections c SET outcome = 'discarded' FROM ai_jobs j WHERE j.correction_id = c.id AND c.status = 'done' AND j.status = 'failed' AND j.error LIKE 'push rifiutato:%'`. La frase è quella che il worker scrive in `correction.ts:1472`. Le altre righe storiche restano `NULL` e passano dal fallback.
- **Vale per entrambe le origini** (`stubwise` ed `external`): il fatto, cioè il push rifiutato, è lo stesso.

**Errori.** Invariati: 404 `not_found` su un progetto invisibile. Nessun errore nuovo.

**Permessi.** Nessuna azione nuova. «Chiedi modifiche» resta `permissions.requestCorrection`, calcolato dal server (`pulls.ts:220-227`): il client lo legge, non lo deduce. Non esiste un «Riprova» nel prototipo e non va aggiunto. La ripartenza automatica la decide il ciclo del server, non il client.

### Cosa farà il renderer

Quasi nulla: l'adattatore passa già `state` e `prState`. Restano tre cose:
- `why: c.why ?? ""` non va toccato: su una `discarded` il server manda `null`, quindi sotto la riga non compare la frase italiana dell'errore;
- il testo con `{{name}}` va scelto secondo il punto 1 del «Da decidere»;
- va aggiornato il commento in `views.ts:142`, che oggi dice «`discarded` non si deriva ancora».

### Da decidere

1. **Il nome in «{{name}} pushed first».** Il server non conosce l'autore: `authorName` è `""` sui colleghi e `"Claude"` sulle PR di Stubwise (`releasePrs.ts:131`), quindi oggi le righe direbbero « pushed first» o «Claude pushed first».
   - (a) Due chiavi senza nome nel renderer, solo nella build app («The author pushed new commits first · …», e su una PR di Stubwise «Someone pushed to the branch first · …»), usate quando il nome manca o la PR è di Stubwise.
   - (b) Il server aggiunge `authorName?: string | null` a `OpenPull`, letto dal provider (una chiamata in più per PR, che la F1 aveva evitato apposta).
   - **Consiglio (a).** Non si inventa un nome, nessun costo sul server, e (b) resta possibile più avanti in modo additivo.
2. **Una scartata conta nel tetto vero?** Il prototipo dice di no («doesn't count») e `prState.autoRound` non la conta, ma `autoRoundsInCurrentSeries` sì, quindi il bottone potrebbe dire «1 of 3» mentre il cancello vede 2.
   - (a) `autoRoundsInCurrentSeries` esclude `outcome = 'discarded'`: è ancora un conteggio DERIVATO, l'invariante resta, ma cambia il comportamento del worker.
   - (b) Si lascia com'è e si annota nel registro.
   - **Consiglio (a)**, perché lo dice la specifica e la riga «doesn't count» altrimenti mente. La stessa divergenza esiste già per le `stopped` (anche quelle «doesn't count» nel prototipo): resta fuori da questa voce e va nel registro.
3. **La notifica `job.failed` su una scartata.** Il prototipo non avvisa nessuno. Il worker invece notifica il fallimento.
   - (a) Non si tocca in questa voce.
   - (b) Si salta `notifyJobFailed` quando l'esito è `discarded`.
   - **Consiglio (a)**, con una riga nel registro: è una scelta di notifiche, non di `/pulls`.

### Test che il renderer scriverà

- `data/backend/real/releasePrs.test.ts`: un elemento di `/pulls` con `correctionHistory: [{ state: "discarded", why: null, commitSha: null, … }]` e `prState.state: "discarded"`. Nella vista devono risultare `corrections[0].state === "discarded"`, `why === ""` e `prState` passato così com'è. Un secondo caso: un server di prima, con la stessa correzione come `stopped`, resta `stopped`.
- `pages/releases`: con quel dato, la seconda riga e la riga del pannello usano il testo scelto al punto 1 (mai « pushed first» col nome vuoto), più il glifo e la voce del filtro «Correction discarded».

## 2. A6 — La card per chi riceve una proposta passata

Registro: `docs/plans/integrazione-registro-rimandi.md:450-453` («Passa al progetto» non crea una card nuova… rimandato: una card per loro).

> ✅ **Deciso (D-2.0, maintainer, 23 nov 2026)**: sì, una notifica a chi
> riceve una proposta passata, push compresa, che **compare nel pannello del
> desktop** e apre la Home (in «Da decidere» la proposta resta). Il prototipo
> ora la ha (d3e1fe9fb), ed è la specifica:
> - `handMailProposal` pubblica `google.proposal_handed` coi destinatari
>   fissi calcolati al passaggio: i membri del progetto che possono
>   confermarla adesso (`canDoActions` su ogni azione), tranne chi l'ha
>   passata e chi ne è già destinatario; nessuno da avvisare, nessuna
>   notifica (`data/mail/proposals.ts`, `publishHandedNotice`);
> - il kind non è più fra `DECISION_NOTIFICATION_KINDS`
>   (`data/seed/notifications.ts`);
> - la card: «A mail proposal handed to {{code}}» / «{{name}} handed it to
>   the project. Decide it in Home.», col nome solo se chi legge lo conosce;
>   decisa da un altro, «Already decided: nothing left to do.»
>   (`proposalDecided`, derivato a lettura; `NotificationItem.tsx`,
>   `notifications.proposalHanded.*`); link `#/home`.
>
> Per il server valgono quindi i punti del contratto qui sotto, con queste
> precisazioni: «Da decidere» (B) è chiuso a favore della card nel pannello
> che apre la Home; il renderer dell'app la presenta come il prototipo (titolo
> e corpo composti, `proposalDecided` da `status = handled` della card o della
> proposta), e non più con «Open in web». Il testo dell'evento resta un
> template i18n senza mittente, oggetto né nome.

### Cosa fa il prototipo

- **Passare**: `handMailProposal` (`apps/desktop/src/renderer/data/mail/proposals.ts:499-508`): rifiuta calendario e «Quale progetto?» (`invalid_action`), una proposta non `open` è `already_handled` (con chi), chi può confermare non passa (`invalid_action`); altrimenti `status = "handed"`, `handedAt`, `handedById`. **Il prototipo non crea nessuna notifica**: nessun punto di `data/mail/` scrive una card (cercato `notif`, `proposal_handed`).
- **Chi la vede dopo**: `canSeeMailProposal` (`data/mail/visibility.ts:170-180`): il destinatario, oppure, se `handedAt !== null`, il MEMBRO del progetto che ha il permesso di OGNI azione (`canDoActions`, `visibility.ts:109-116`). Vede l'estratto, di una riunione nemmeno quello (`proposals.ts:176-185`), e nessuna origine (`originFor` → `null`, `proposals.ts:286-301`). Chi l'ha passata è mascherato se chi guarda non lo conosce (`proposals.ts:152-161`).
- **Dove la trova**: in Home, «Da decidere»: `listMailDecisions` (`proposals.ts:270-280`) = aperte che vede + passate che può confermare ora (`canConfirmNow`, `proposals.ts:138-140`).
- **Il pannello notifiche non mostra MAI le decisioni**: `DECISION_NOTIFICATION_KINDS` (`data/seed/notifications.ts:350-361`) contiene `google.proposal` e `google.proposal_handed` («Le decisioni vivono in Home, le proposte della posta in Mail»); `seed.test.ts:534` lo verifica sul seme. `NotificationItem.tsx` non ha un ramo per le proposte.
- **Decisa da un altro**: la prima decisione chiude per tutti; una seconda è `already_handled` con `byId` (`proposals.ts:39-41, 62-64, 446, 489`). L'«Ignora» di una passata è permesso solo a chi può confermarla (`proposals.ts:489-490`, altrimenti `forbidden`).
- **Testi** (`i18n/locales/en.json`): `…handedHeader` «Handed to {{code}} by {{name}}» (r. 6376), `outcome.handedBy`/`handedByYou` (6432-6433), `outcome.raced_handed` (6439), toast `handed`/`already_handed` (1667, 1672). Nessun testo per una card di notifica di una proposta passata: **non c'è**.

### Cosa c'è oggi

- **Server, passaggio**: `handMailProposal` (`apps/server/src/services/mail-proposals-decide.ts:414-437`) scrive solo `handedAt`/`handedByUserId` con un UPDATE guardato; docblock: «nessuna card nuova *(O)*: la si trova in `/proposals?status=handed`». Non chiude nemmeno la card di chi passa.
- **Server, chi la vede/decide**: `loadDecidable` (`mail-proposals-decide.ts:114-116`) e `listMailProposals` (`apps/server/src/services/mail-proposals.ts:142-149`): non destinatario solo con `handedAt` e `coversAll` (permesso di OGNI azione, `mail-proposals-decide.ts:119-126`) — la stessa regola del prototipo.
- **Server, chiusura**: `closeCards` (`mail-proposals-decide.ts:136-147`) chiude solo le card scritte in `email_proposal_recipients.notification_id`.
- **Il kind esiste già** per le proposte di PRIMA (`mailbox_owner`): `google.proposal_handed` nell'enum (`packages/db/src/schema.ts:1906`), audience `project_deciders` (`packages/notifications/src/routing.ts:162, 335-339`), pubblicato da `handToProject` (`apps/server/src/services/google-proposal.ts:1303-1400`), titolo push (`packages/i18n/src/catalog.ts:535`). ⚠️ Due differenze che lo rendono **non riusabile così com'è**: (1) `project_deciders` prende chi ha ALMENO UNO dei permessi delle azioni (`routing.ts:281-295`), la proposta condivisa la vede solo chi li ha TUTTI; (2) l'evento porta `from`/`subject`/`handedBy` (email), mentre il decisore di una condivisa non vede l'origine e il nome è mascherato.
- **Inbox**: `/api/inbox/:id/act` instrada sulla proposta condivisa solo se trova la riga in `email_proposal_recipients` per quell'utente (`apps/server/src/services/inbox.ts:385-430`); un `google.proposal_handed` senza quella riga finisce in `answerGoogleProposal`, l'esecutore di PRIMA (`inbox.ts:436-440`). `sourceProposalId` si deriva solo per `google.proposal` (`inbox.ts:1028-1031, 1859-1893`). La visibilità a lettura esenta solo `google.proposal` dal filtro di appartenenza (`packages/notifications/src/inbox-visibility.ts:46-67`): un `google.proposal_handed` è già filtrato per membro/full admin e progetto non archiviato.
- **Adattatore reale**: «Da decidere» legge già le passate (`apps/desktop/src/renderer/data/backend/real/mailProposals.ts:50-57`, `status: "handed"`). Le notifiche (`data/backend/real/notifications.ts:10-16, 433-483`) mostrano TUTTE le card dell'inbox, comprese `google.proposal*`, con «Open in web» (`webHrefFor`): oggi le card delle proposte condivise compaiono nel pannello, al contrario del prototipo.

### Contratto

**Nessuna rotta nuova; nessun `notification_kind` nuovo**: si riusa `google.proposal_handed`, che esiste nell'enum da prima. Il rollback del server resta quindi quello di oggi per il kind (le righe `google.proposal_handed` esistono già in produzione); scendere a un'immagine che non conosce l'instradamento qui sotto lascia però le card nuove decidibili SOLO da `/api/me/mail/proposals/:id/*` (vedi «rollback» in fondo).

1. **Quando**: in `handMailProposal` condiviso, nella STESSA transazione dell'UPDATE di `handedAt` (oggi è un UPDATE singolo: va portato in `db.transaction`), solo se l'UPDATE ha preso la riga.
2. **A chi**: un destinatario alla volta (come `publish-shared.ts`), calcolato dal server: i membri del progetto della proposta (`projectViewerIds`, full admin compresi come membri impliciti) per cui `coversAll(proposal, permessi nel progetto)` è vero, ESCLUSI chi ha passato e chi è già destinatario (riga in `email_proposal_recipients`, o per `meeting_invitees` `canSeeMeeting` vero): ha già la sua card. Nessuno da avvisare → nessuna card, il passaggio riesce lo stesso. Mai al webhook d'istanza (come la proposta d'origine).
3. **Legame card → proposta**: l'evento porta `proposalId = email_proposals.id` (ancora immutabile, vera alla pubblicazione, come la card di prima). Il server ritrova la proposta con `kind = 'google.proposal_handed' AND event->>'proposalId' = <id>` e `email_proposals.audience IN ('mail_recipients','meeting_invitees')` (è l'audience della RIGA, non un campo dell'evento, a distinguerla da una passata di prima). In alternativa una tabella di legame: vedi «Da decidere» (A).
4. **Evento (jsonb)**: `kind`, `proposalId`, `projectId`, `projectName`, `options`/`actions` = le azioni della proposta nell'ordine + «Non fare nulla» per ultima (stessa mappa di `buildSharedProposalEvent`, così `/act` usa gli stessi indici delle card dei destinatari), `question` da template i18n (nuova chiave, es. `google.proposal.question.handedShared`: «Una proposta della posta passata a {project}») **senza** mittente, oggetto, casella né nome di chi passa. Niente `from`/`subject`/`handedBy`: il decisore non vede l'origine (prototipo `originFor`), e il nome è mascherato a lettura.
5. **Lettura (`/api/inbox`, `InboxItem`)**, tutto DERIVATO A LETTURA, nulla nel jsonb:
   - `google.sourceProposalId: string | null` (campo che esiste, `.nullable().default(null)`): per questa card = `email_proposals.id` ritrovato come al punto 3, sovrascrive il payload. Serve al renderer per riconoscerla.
   - `google.handed: boolean` resta `false` su questa card (vale solo sulla card di chi passa, `inbox.ts:1393`).
   - `google.decision`: esito della riga quando la card è `handled` (stessa `decisionFrom`).
   - `google.blockedIndices`: coi permessi di ORA di chi guarda (la regola esiste già in `readGoogle`).
   - Nessun campo nuovo obbligatorio; se se ne aggiunge uno, `.optional()`/`.default()`.
6. **Decidere dalla card** (`POST /api/inbox/:id/act`, `answer` con `optionIndices`): per un `google.proposal_handed` legato a una proposta CONDIVISA il dispatcher va su `confirmMailProposal`/`ignoreMailProposal` (`mail-proposals-decide.ts`) PRIMA del ramo di prima; `loadDecidable` ricontrolla `handedAt` + `coversAll` (permessi di adesso). Errori come oggi: `already_handled` (+ `handledBy`), `not_found` (non più decisore, progetto non visibile), `forbidden`, `invalid_answer`. «Passa» e «Sposta» non si offrono su questa card (`hand_to_project` resta derivato solo sulla card del proprietario).
7. **Chiusura per tutti**: `closeCards` chiude ANCHE le card `google.proposal_handed` della proposta (stesso UPDATE `status='handled'` su `open`), a ogni decisione (conferma, ignora). Una decisione presa da `/api/me/mail/proposals/:id/*` le chiude allo stesso modo. Nel worker **non ho trovato** un percorso che chiuda le card delle proposte condivise quando il thread le supera (`classify-v2.ts`, `publish-shared.ts`): se esiste o si aggiunge, deve chiudere anche queste.
8. **Push/Slack**: la card va in push come le altre (titolo `push.title.google.proposal_handed` esiste); nessun testo con mittente/oggetto.

**Rollback**: nessun kind nuovo, quindi niente 500 su `/api/inbox`. Un server vecchio però instraderebbe `/act` di queste card sull'esecutore di prima (`answerGoogleProposal`, che cerca la riga per `proposal_notification_id`/`findHandedSource`): va verificato che risponda un errore (`proposal_stale`/`not_found`) e non esegua nulla su una riga condivisa; la voce di deploy-log lo deve dire.

### Cosa farà il renderer

- «Da decidere» non cambia: le passate arrivano già da `/proposals?status=handed` (`real/mailProposals.ts:50-57`); dopo una decisione rilegge come oggi.
- Il pannello notifiche: vedi «Da decidere» (B). Con la scelta consigliata, `presentInboxItem` riconosce `google.proposal_handed` (e `google.proposal` con `google.sourceProposalId` di una condivisa) quando la Posta è integrata (`featureIntegrated("mail")`) e la porta a Home («Da decidere», `#/home`, come `projectlessLink` del seme) invece di «Open in web».
- Una card `handled` (decisa da un altro) compare archiviata alla rilettura; nessun testo nuovo nel renderer.

### Da decidere

- **(A) Legame card → proposta.** (a) `event->>'proposalId'` + audience della riga (come le passate di prima, c'è già l'indice); (b) una tabella `email_proposal_handed_cards(proposal_id, user_id, notification_id)`, che `closeCards` e `/act` leggono come `email_proposal_recipients`. **Consiglio (a)**: nessuna migrazione, stesso schema delle passate di prima; NON riusare `email_proposal_recipients`, che renderebbe il decisore un destinatario (vedrebbe il messaggio).
- **(B) La card nel pannello del desktop.** (a) come il prototipo: le `google.proposal*` non compaiono nel pannello (Home e Mail le mostrano), la card serve a push, web vecchio e mobile; (b) compaiono e aprono Home; (c) come oggi, «Open in web». **Consiglio (b)** finché esiste il web vecchio (la card non resta muta e non porta fuori dall'app), passando ad (a) col ritiro del web; vale anche per le card dei destinatari di oggi.
- **(C) Chi ottiene i permessi DOPO il passaggio** non riceve la card (la proposta la vede lo stesso in «Da decidere»). (a) limite accettato, come le card di prima; (b) card a lettura. **Consiglio (a)**.
- Vicino ma fuori voce: la card di chi passa (e degli altri destinatari che non possono confermare) oggi resta `open` dopo il passaggio; il prototipo la toglie da «Da decidere». Da chiudere nella stessa transazione? Lo segnalo, non lo contratto.

### Test che il renderer scriverà

- `data/backend/real/notificationsHanded.test.ts` (nuovo): un `InboxItem` `google.proposal_handed` con `google.sourceProposalId` → presentato secondo (B); lo stesso item SENZA `google` (server vecchio) → «Open in web», non lancia; uno `handled` → `archived: true`.
- `data/backend/real/mailProposalsShared.test.ts`: `listMailDecisions` con una passata decidibile e una passata decisa da un altro (`already_handled` alla conferma → `byId`).
- `ComingSoon.test.tsx` e `integration.test.ts` nel giro filtrato se cambia ciò che la Posta accende.

## 3. A6 — Le richieste nate da una riunione

Voce del registro: `docs/plans/integrazione-registro-rimandi.md:520-524` (F5a, «Task da questa riunione» senza le RICHIESTE) e `:606-610` (pannello per nota senza link al progetto, `projectCode: null`). Percorsi del desktop relativi a `apps/desktop/src/renderer/`.

### Cosa fa il prototipo

- **Una lista sola, task e richieste insieme** — `data/mail/transcripts.ts:100-142` (`bornFrom`). Prende i `resultCodes` delle proposte `source: "transcript"` della riunione, ordinati per `decidedAt` (`:109-112`). Per ogni codice:
  - se è una task visibile a chi guarda nel suo progetto, la riga è la **task** (`:124-127`);
  - altrimenti cerca la **richiesta** (`state.requests`, per codice). La salta se il progetto è invisibile o se chi guarda non ne è membro (`:129-131`);
  - richiesta **non convertita** → riga `kind: "request"` (`:132-134`);
  - richiesta **convertita** → al posto suo escono **le sue task** (`request.taskIds`), solo quelle che esistono ancora e che chi guarda vede (`:136-139`). Se tutte le task sono state eliminate, non esce niente.
  - doppioni tolti per `(kind, id)` (`:120-122`).
- **La riga «richiesta»** — `requestItem`, `transcripts.ts:80-91`. Campi: `kind: "request"`, `id` (l'id della richiesta), `code` (`<PROGETTO>-R<n>`), `title`, `status: "done"` se `archived` e `"open"` altrimenti, `inProgress: false`, `dueDate: null`, `departmentId: null`. Il tipo è `MeetingTask` in `data/types.ts:879-888` e non ha `projectCode`.
- **Una richiesta fusa** — `data/api-mutations.ts:1150-1169`. La sorgente va in `status = "archived"` con `mergedIntoId = target.id`. Nella lista quindi la riga resta **la sorgente stessa**, col suo codice, «Done» e il link a lei. **Non** viene sostituita dalla destinazione.
- **Una richiesta eliminata**: nel prototipo non l'ho trovata. Non esiste una mutazione che la elimini: `grep deleteRequest` non dà risultati. L'unico caso coperto è «codice non trovato → salta» (`:129-131`).
- **Chi vede cosa** — `transcripts.ts:215-220` e `:247-254`. `null` (sezione assente) a chi non è membro del progetto dell'evento (R-I21). Per nota serve in più `canSeeTranscript`. Il prototipo NON modella `backlog.view_all` sulle richieste: un membro le vede tutte.
- **La UI**:
  - `pages/calendar/meetingParts.tsx:179-202`: una task apre la task. Una richiesta diventa un `Link` a `/p/$code/requests?request=<task.id>` solo se `projectCode !== null`, altrimenti è testo senza link.
  - Stato «Request» per una richiesta aperta: `meetingParts.tsx:236-238`.
  - `projectCode` è una prop della LISTA (`meetingParts.tsx:107-108`, `MeetingSummary.tsx:44-45`). Il dettaglio evento passa `project?.code ?? null` (`pages/calendar/EventDetail.tsx:403`), la scheda di preparazione `project.code` (`pages/calendar/MeetingPrep.tsx:256-258`). Il pannello per nota passa **`null` fisso** (`pages/home/blocks/MailDecisionItem.tsx:199-203`): da lì le richieste non hanno link. È il rimando di `:606-610`.

### Cosa c'è oggi

- **Adattatore**: `data/backend/real/meetings.ts:77-93` (`tasksView`).
  - Legge già `kind === "request"`.
  - Rende `code ?? ""` («una richiesta nata da poco può non avere ancora il codice», `:83`).
  - Non legge `projectCode` né altri campi.
  - Sopra c'è anche `meetingTasksOf`, che la scheda di preparazione usa per `recentMeetings` (`data/backend/real/meetingPrep.ts:53`): le richieste arriveranno anche lì.
- **Schema**: `packages/shared/src/schemas/google.ts:787-799`. `meetingTaskSchema` ha `kind` `task|request`, `id` uuid, `code` nullable con default null, `title`, `status` `open|done|late`, `inProgress`, `dueDate` e `departmentId`. Non ha `projectCode`. `meetingTasksSchema` è `.nullable()`.
- **Rotte**: `GET /api/me/meetings/:noteId/tasks` (`apps/server/src/routes/me-meetings.ts:25-32`) e `GET /api/me/calendar/events/:id/tasks` (`apps/server/src/routes/me-calendar.ts:241-247`). Tutte e due passano da `tasksOf` (`apps/server/src/services/meetings.ts:116-156`):
  - `null` se chi guarda non ha permessi nel progetto (`projectPermissionsOfUser`: membro **o full admin**, diverso dal prototipo, vedi Da decidere 4);
  - prende i `results` delle proposte della nota nel progetto, **solo `kind === "task"`** (`:127`);
  - per le task filtra solo per `tickets.projectId`.
  Le richieste oggi non escono.
- **Cosa scrive la conferma**: `apps/server/src/services/mail-proposals-decide.ts:278-288`. `create_backlog_item` chiama `enqueueBacklogIntake` (`apps/server/src/services/backlog-intake.ts:53-79`): un `backlog_jobs` con `kind: "intake"` e `projectId` = il progetto della proposta. In `email_proposals.results` (jsonb, `packages/db/src/schema.ts:5953`) scrive `{ kind: "request", id: <id del job>, code: null }`.
- **Il legame job → voce ESISTE GIÀ**: `backlog_jobs.result_item_id` (`packages/db/src/schema.ts:4047-4051`, FK verso `backlog_items` `ON DELETE SET NULL`). Lo scrive il **worker**, nella stessa transazione in cui crea la voce o la fonde:
  - voce nuova: `apps/worker/src/backlog/intake.ts:306-309`;
  - auto-merge in una voce esistente: `:199-208`. Qui il job punta alla voce **canonica** in cui il feedback è confluito.
  Finché il job non è `done` vale `null`. Stati del job: `queued|running|done|failed` (`packages/shared/src/schemas/backlog.ts:42`).
  Il legame si legge già così altrove: `apps/server/src/routes/project-requests.ts:117-133` (job → richiesta, con la visibilità) e `apps/server/src/services/product-questions.ts:142`.
- **Voce, fusione, conversione**:
  - stati di `backlog_items.status`: `new|refining|ready|converted|archived`;
  - `merged_into_id` (`schema.ts:3953`) per una fusione A MANO successiva;
  - le task di una convertita: `backlog_item_tickets` con `role = 'converted_to'` (`schema.ts:4010-4022`, scritto da `apps/server/src/services/task-writes.ts:247`). Attenzione: `role = 'origin'` è il ticket d'origine dell'intake, non una task nata dalla conversione;
  - codice `<CODICE>-R<number>` come in `apps/server/src/services/project-requests.ts:117`;
  - visibilità delle richieste: `requestVisibility` (`project-requests.ts:22-24`), cioè `backlog.view_all` nel progetto oppure essere fra i richiedenti.
- **Eliminazione di una voce**: non ho trovato una rotta che elimini `backlog_items`. Restano la cascata del progetto e il `SET NULL` su `result_item_id`.

### Contratto

**Migrazione: nessuna.** Il legame job → voce è `backlog_jobs.result_item_id`, già scritto dal worker al momento giusto. `email_proposals.results` resta com'è: `id` = id del job, e non si riscrive nessuna riga. La voce si risolve **a lettura**, quindi copre anche le proposte confermate prima del rilascio, come vuole l'invariante «si deriva a lettura».

**Schema** (`packages/shared/src/schemas/google.ts`, `meetingTaskSchema`). Solo cambi additivi:

```ts
projectCode: z.string().nullable().default(null),   // NUOVO, su ogni riga (task e richiesta)
pending: z.boolean().default(false),                 // NUOVO, solo se passa l'opzione (b) di «Da decidere 1»
```

Il resto resta invariato: `id` uuid, `code` nullable con default null, `status` `open|done|late`. Un client vecchio scarta i campi nuovi. Un server vecchio non li manda, e i default valgono `null` e `false`.

**`tasksOf`** (`apps/server/src/services/meetings.ts`), con le due rotte invariate:

1. Una sola sequenza di `results`, `task` e `request` insieme: proposte per `decidedAt` crescente, e dentro ogni proposta l'ordine di `results`. Oggi raccoglie solo le task.
2. `kind: "request"`: legge `backlog_jobs` con `id = result.id` **e** `project_id = <progetto della riunione>`, e da lì `result_item_id`:
   - **job `done` con voce**: la riga è la **voce** `result_item_id`. Il job punta sempre a una voce del suo progetto. Se si tratta di un auto-merge, la voce è quella canonica (lo garantisce il worker).
   - **voce `converted`**: niente riga richiesta. Escono **le task** collegate con `backlog_item_tickets.role = 'converted_to'`, nella posizione della richiesta, con la stessa forma e lo stesso filtro delle righe task (punto 4). Escono nell'ordine di `backlog_item_tickets.created_at`, ed è una scelta mia (il prototipo segue l'ordine di `taskIds`). Se nessuna task resta, non esce niente.
   - **voce fusa A MANO dopo** (`merged_into_id` non null, `archived`): la riga è **la voce sorgente**, col suo codice, `status: "done"`. Non si segue `merged_into_id`, come nel prototipo (`api-mutations.ts:1163-1164` e `transcripts.ts:86`). Vedi «Da decidere 2».
   - **voce `new|refining|ready`** → `status: "open"`. **`archived`** → `status: "done"`.
   - **job `queued|running`**: vedi «Da decidere 1».
   - **job `failed`**, job inesistente, o `done` con `result_item_id` null (voce eliminata): **nessuna riga**. Non c'è niente che si possa affermare.
3. Forma della riga richiesta:
   - `kind: "request"`, `id` = **id della voce** (`backlog_items.id`, mai l'id del job: è il `?request=` del link);
   - `code` = `${projects.code}-R${number}`, oppure `null` se il progetto non ha codice;
   - `title` = `backlog_items.title`, `status` come al punto 2;
   - `inProgress: false`, `dueDate: null`, `departmentId: null`;
   - `projectCode` = `projects.code` del progetto della riunione.
4. **Visibilità**, filtrata nella WHERE prima di comporre la lista, mai dal client:
   - resta il cancello attuale: `null` a chi non ha permessi nel progetto. Da quel punto in poi chi guarda vede il progetto, quindi `projectCode` non rivela niente;
   - una voce **non visibile** a chi guarda secondo `requestVisibility` (senza `backlog.view_all` e senza essere fra i richiedenti) **non esce**. Il link porterebbe a un 404, e la riga direbbe che la voce esiste;
   - le righe vengono SOLO dal progetto della riunione: job, voce e task con `project_id` uguale. Una task convertita spostata in un altro progetto non esce;
   - `projectCode` vale `null` solo se il progetto non ha codice. Il client non ricava mai il codice da altri dati.
5. Doppioni tolti per `(kind, id)` **dopo** la risoluzione: due richieste confluite per auto-merge nella stessa voce danno una riga sola.
6. `projectCode` va anche sulle righe `task`: stesso valore, è additivo.
7. **Errori**: invariati. `404 not_found` a chi non è fra gli invitati (per nota) o se la riga di calendario non è sua (per evento). `200 null` a chi non è membro. Nessun codice nuovo.
8. Il conteggio `proposedTasks` resta invariato: conta solo `create_task`, come il prototipo (`transcripts.ts:165`).

### Cosa farà il renderer

- `data/types.ts`: `MeetingTask` guadagna `projectCode?: string | null` (e `pending?: boolean` se passa la (b)). `requestItem` del prototipo lo riempie col codice del progetto della richiesta (`transcripts.ts:80-91`).
- `data/backend/real/meetings.ts:77-93`: legge `projectCode: t.projectCode ?? null` (e `pending: t.pending === true`).
- `pages/calendar/meetingParts.tsx:190`: il link usa `task.projectCode ?? projectCode`. Il pannello per nota (`MailDecisionItem.tsx:201`, `projectCode={null}`) ottiene così il link dal server. Senza codice, o con `pending`, la riga resta testo senza link.
- Nessuna deduzione di permessi o di stato lato client: la riga che arriva è quella che si mostra.

### Da decidere

1. **Una richiesta ancora in intake** (job `queued|running`, nessuna voce). Il prototipo non ha questo stato: la richiesta nasce subito.
   - (a) Non esce finché il worker non ha finito. Semplice, ma la riunione sembra non aver prodotto nulla per qualche minuto.
   - (b) Esce con `id` = id del job, `code: null`, `title` = titolo del payload del job, `status: "open"`, `pending: true` (campo nuovo, default false) e senza link.
   - **Consiglio (b)**: l'adattatore già prevede `code` assente (`meetings.ts:83`), e il campo esplicito evita di far valere `id` per due cose diverse senza segnalarlo.
2. **Una richiesta fusa a mano in un'altra.**
   - (a) La sorgente, «Done», col link a lei, come il prototipo. La pagina della richiesta dice «Unita a R12».
   - (b) La destinazione, seguendo `merged_into_id`.
   - **Consiglio (a)**: il prototipo è la specifica. L'auto-merge dell'intake punta già alla canonica per costruzione. Se si vuole la (b), è un cambio del prototipo prima che del server.
3. **Visibilità delle task nelle righe.** Oggi le righe task non applicano `tickets.view_all` (`visibleTasksCondition`, `apps/server/src/services/task-view.ts:66-77`).
   - (a) Lasciare così.
   - (b) Applicare `visibleTasksCondition` a tutte le righe task, dirette e convertite, come per le richieste con `requestVisibility`.
   - **Consiglio (b)**: «gli elenchi filtrano nella WHERE», e una riga visibile che apre una task invisibile è un 404.
4. **(Fuori dalla voce, da segnalare)** Il cancello di `tasksOf` (`projectPermissionsOfUser`) lascia passare un full admin non membro. Il prototipo lo esclude (R-I21, `transcripts.ts:19-21`). Non lo tocca questo contratto.

### Test che il renderer scriverà

- `data/backend/real/meetings.test.ts` (nel `describe` «F5: Task da questa riunione», `:94`):
  - una riga `kind: "request"` con `projectCode`: codice, titolo, stato e `projectCode` letti;
  - una risposta **senza** `projectCode` e senza `pending` (server di prima): `projectCode: null`, `pending: false`, nessun crash;
  - `code: null` → `""`;
  - un valore di `status` sconosciuto → `"open"`.
- `pages/calendar/MeetingSummary.test.tsx`:
  - per nota (`projectCode={null}` della prop) una richiesta con `projectCode` dal server diventa un link a `/p/<code>/requests?request=<id>`;
  - senza `projectCode` resta testo;
  - con `pending` resta testo, con lo stato «Request».
- Prototipo, `data/mail/transcripts` (`bornFrom`):
  - richiesta aperta: riga con `projectCode`;
  - convertita: escono le sue task e non la richiesta;
  - fusa: la sorgente «Done»;
  - richiesta di un progetto di cui chi guarda non è membro: nessuna riga.

## 4. A6 — Il badge delle proposte di riunione nell'elenco delle conversazioni

Registro: `docs/plans/integrazione-registro-rimandi.md:528-531`.

### Cosa fa il prototipo

- Il badge della riga è `MailThreadRow.openProposals` (`apps/desktop/src/renderer/data/model.ts:2845`), calcolato in `threadRow` (`data/mail/reads.ts:104-106`): le proposte con `status === "open"` il cui `sourceId` è il Message-ID di un messaggio della conversazione VISIBILE a chi guarda, e che `canSeeMailProposal` gli lascia vedere. Le passate (`handed`) non contano.
- Le proposte di una riunione (`source: "transcript"`, seme `data/seed/mail/proposals.ts:187, 241`) hanno `sourceId` = Message-ID dell'email di Gemini, quindi contano sulla riga della conversazione di quell'email, se chi guarda le vede: `canSeeMailProposal` → `isProposalRecipient` (`visibility.ts:136-155`): membro del progetto e, se c'è la trascrizione, `canSeeTranscript` (invitato dell'evento; senza evento, chi vede l'email, `visibility.ts:126-133`).
- Lo usano `ThreadRow.tsx:80` (etichetta lunga), `ThreadRow.tsx:169-173` («N to decide») e `MailPage.tsx:189` (le righe «waiting»).

### Cosa c'è oggi

- **Server**: `GET /api/me/mail/threads` (`apps/server/src/routes/me-mail.ts:1345-1384`) conta (1) le condivise con `audience = 'mail_recipients'` per cui chi guarda ha una riga in `email_proposal_recipients`, ritrovate per Message-ID dai SUOI messaggi, aperte (`classified`/`proposed`) e non passate; (2) le proposte di PRIMA (`mailbox_owner`). Le `meeting_invitees` **non contano**. Due differenze col prototipo anche sul ramo (1): non controlla che il progetto sia visibile ADESSO (`proposalPermissionsOf`) né il destinatario per riunione.
- Aprendo la conversazione invece `listMailProposals({ thread })` (`apps/server/src/services/mail-proposals.ts:113-124, 140-156`) prende anche le riunioni: `rfcMessageId` fra le chiavi del thread **oppure** `meetingNoteId` fra le `meeting_notes` dei messaggi del thread, con `canSeeMeeting` derivato e progetto visibile.
- **Schema**: `openProposals: z.number().int().min(0).default(0)` (`packages/shared/src/schemas/google.ts:593`), già c'è.
- **Adattatore**: `rowOf` copia `t.openProposals` (`apps/desktop/src/renderer/data/backend/real/mail.ts:118`). Nessun calcolo lato renderer.

### Contratto

- **Nessun campo nuovo, nessuna rotta nuova, nessun kind.** Cambia solo il SIGNIFICATO di `openProposals` su `GET /api/me/mail/threads`: è il numero di proposte che `listMailProposals(viewer, { thread: { threadId, accountId } })` restituirebbe con `status === "open"` (condivise `mail_recipients` E `meeting_invitees`), più le proposte di prima aperte come oggi. Una regola, due letture: chi cambia l'una cambia l'altra (meglio una funzione condivisa che conta per una pagina di thread).
- Per le `meeting_invitees`: chiave = `rfcMessageId` fra le chiavi dei messaggi del thread nella casella di chi guarda, OPPURE `meetingNoteId` fra le note di quei messaggi; «destinatario» = `canSeeMeeting(meetingNoteId, viewer)` DERIVATO a lettura (un invitato aggiunto dopo conta, uno tolto no); progetto visibile ora (`proposalPermissionsOf` non nullo); stato `classified`/`proposed` e `handedAt` nullo.
- Le stesse due condizioni (progetto visibile, stato) valgono anche per il ramo `mail_recipients`, che oggi non controlla la visibilità del progetto: altrimenti la riga promette una proposta che aprendo la conversazione non c'è.
- Una proposta si conta UNA volta per thread anche se trovata per entrambe le chiavi.
- Costo: per pagina, una query per le chiavi; `canSeeMeeting`/`proposalPermissionsOf` per le sole proposte candidate (al più quelle della pagina), non per thread.
- Additivo verso i client: lo schema non cambia; un server vecchio dà il conteggio di prima (le riunioni mancano, nessun errore).
- **`/summary`** (badge di nav, `me-mail.ts:879-972`) conta le NOTIFICHE `google.proposal` aperte: **non l'ho verificato** per le riunioni; non è in questa voce.

### Cosa farà il renderer

- Niente codice nuovo: `rowOf` già copia il numero, e `ThreadRow`/`MailPage` lo usano. Si toglie la voce dal registro e il test qui sotto fissa il comportamento.

### Da decidere

- Nessuno sul contratto. Solo una verifica: se `/summary` deve contare anche le proposte di riunione (oggi conta le card `google.proposal`, e le proposte di riunione hanno una card per invitato?) — **non verificato**, fuori voce.

### Test che il renderer scriverà

- `data/backend/real/mailRead.test.ts` (o `mailPage.test.tsx`): una riga con `openProposals: 1` per una conversazione che contiene solo l'email di Gemini → «1 to decide» e la riga fra le «waiting»; una risposta SENZA `openProposals` (server vecchio) → 0, nessun segno.
- Lato server (non del renderer, lo segnalo all'altra sessione): `me-mail.test.ts` con una proposta `meeting_invitees` vista da un invitato (conta), da un non invitato che ha l'email (non conta), passata (non conta), su un progetto non più visibile (non conta), e la parità col numero di `GET /api/me/mail/proposals?thread=&account=&status=open`.

## 5. A6 — «Riprova» per un fillMailBody non salvato

Registro: `docs/plans/integrazione-registro-rimandi.md:371-373` (F3, punto (a)).

**Cosa fa il prototipo**

- Il prototipo **non ha** `fillMailBody` nel suo catalogo: è una delle tre voci
  che il server propone e che lì «fa la Posta»
  (`apps/desktop/src/renderer/data/claude/catalogParity.test.ts:18-24`). Quindi
  **non specifica né il fallimento né il «Riprova»**: non ho trovato in
  `data/claude/`, `domain/claude` o `pages/claude` nessun ramo di riprova per
  questa azione.
- Il fallimento esiste solo nella build app: `mailNotSaved?: { text }` sull'evento
  `proposal` (`apps/desktop/src/renderer/data/model.ts:1438-1444`); la scheda,
  se c'è, non dice mai «Fatto» (`pages/claude/conversation/ProposalCard.tsx:408-410`)
  e mostra `MailNotSaved`: frase + «Copia il testo» + «Copiato»
  (`ProposalCard.tsx:990-1015`, con il commento «Retry non c'è in questa fetta»).
- Testi: `claude.conversation.proposal.mailNotSaved` = «Non salvato su Gmail: il
  testo non è nella tua bozza.» / «Not saved to Gmail: the text isn't in your
  draft.», `copyText`, `copied` (`i18n/locales/it.json:4168-4170`, stesse righe in
  `en.json`). Nessuna chiave per «Riprova» in quel blocco; il generico «Riprova»
  esiste altrove (es. `en.json:370` e molte altre `retry`).

**Cosa c'è oggi**

- Adattatore: `mailNotSavedOf` (`data/backend/real/claudeChatActions.ts:413-422`)
  cerca nel gruppo un'azione `fillMailBody` con `effectFailure ===
  "mail_not_saved"` (`?? null`: server di prima = riuscita) e prende
  `args.text`; `proposalEvent` lo mette nell'evento (`:424-447`). Nessuna rotta di
  riprova, nessun dato su chi possa riprovare.
- Server:
  - catalogo: `fillMailBody` (`apps/server/src/claude-actions/catalog.ts:471-489`)
    nella transazione controlla solo il bersaglio (`services/mail-body-target.ts`:
    casella di chi conferma, non disabilitata, con `gmail.modify`; thread, se c'è,
    in QUELLA casella → `ok | not_found | forbidden`, rifiuto `mail_<target>`) e
    registra il seguito `saveMailBody(user.id, input, actionId)`; non si annulla
    (`inverse: null`).
  - seguito: `saveMailBody` (`claude-actions/effects.ts:112-127`) dopo il commit
    chiama `effects.mailBody`; se lancia, `markEffectFailure(actionId,
    "mail_not_saved")`. I seguiti sono **attesi** nella richiesta di conferma
    (`claude-actions/execute.ts:111`), quindi l'esito è già scritto quando la
    conferma risponde.
  - `effects.mailBody` = `fillDraftBody` (`routes/claude-actions.ts:27-41`,
    `services/mail-drafts.ts:681-702`): prende la bozza attiva per (utente,
    casella, thread, modo) o ne costruisce una dal thread, e sostituisce SOLO il
    corpo (`saveDraft`, senza `baseUpdatedAt` né `overwrite`). Errori possibili
    (`DraftError`, `mail-drafts.ts:86-97`): `not_found`, `account_disabled`,
    `google_scope_missing`, `account_unavailable`, `token_expired`,
    `draft_changed` (bozza cambiata da Gmail, `:411`), `google_unavailable`,
    `attachment_unavailable`, `storage_not_configured`, `too_many_attachments`,
    `too_large`. Una bozza **sparita su Gmail** (404) non è un errore: si ricrea
    (`:403-414`). Oggi il codice dell'errore si perde: `throw new
    Error("fillMailBody: <code>")`, sulla riga resta solo `mail_not_saved`.
  - dato: `claude_actions.effect_failure` (`packages/db/src/schema.ts:4274-4280`),
    esposto come `effectFailure` sulle azioni della vista del gruppo
    (`packages/shared/src/schemas/claude-actions.ts:449-461`,
    `claude-actions/proposals.ts:437-444`). La vista **non porta l'id
    dell'azione**. Rotte esistenti sotto `/api/claude`: `proposals/:id/confirm`,
    `proposals/:id/cancel`, `groups/:id/undo` (`routes/claude-actions.ts`).
  - test esistente: `claude-actions-mail.test.ts:123-146`.

**Contratto**

1. Vista del gruppo (`claudeActionGroupViewSchema.actions[]`), campo NUOVO e
   additivo:
   `canRetryEffect: z.boolean().default(false)` — calcolato dal SERVER: vero
   solo se `fn === "fillMailBody"`, `effectFailure !== null`, e chi guarda è
   `claude_action_groups.requester_id` (chi ha confermato, che è anche l'utente
   del seguito: `execute.ts:137-141`). Il client non lo deduce da
   `effectFailure`.
2. Rotta: `POST /api/claude/groups/:id/actions/:index/retry`
   - `params`: `id` uuid del gruppo, `index` intero ≥ 0 = posizione nell'array
     `actions` della vista del gruppo (ordine `seq`). Body: nessuno (`{}`
     accettato). Il testo è quello salvato in `args.text`, mai uno mandato dal
     client.
   - `config.access: { kind: "user" }` (sessione o PAT, come le altre rotte di
     `/api/claude`; il token del turno → 403 `chat_tool_forbidden` per
     l'allowlist). Nessuna riconferma: `fillMailBody` è B e non manda nulla.
   - Passi del server: legge gruppo + azione; riverifica il bersaglio ADESSO con
     `mailBodyTarget`; chiama `fillDraftBody` con gli `args` salvati; se riesce,
     `UPDATE claude_actions SET effect_failure = NULL WHERE id = … AND
     effect_failure IS NOT NULL`; se no, lascia `mail_not_saved`.
   - 200: `claudeActionGroupViewSchema` del gruppo aggiornato (l'azione con
     `effectFailure: null`, `canRetryEffect: false`).
   - Errori (`{ code, message, reason? }`, `reason` nuovo e opzionale):
     - 404 `not_found`: gruppo inesistente, gruppo di un altro (come `undo` con
       `not_yours`: non si conferma l'esistenza), `index` fuori intervallo.
     - 409 `not_retryable`: l'azione non è `fillMailBody` (nessun seguito da
       rilanciare).
     - 409 `already_saved`: `effectFailure` è già `null` (riuscita al primo
       colpo o a un riprova precedente). Il client lo tratta come successo e
       rilegge.
     - 409 `mail_not_found`: casella scollegata/non più sua, o thread non più
       nella casella (stessi codici del rifiuto del catalogo, `mail_<target>`).
     - 409 `mail_forbidden`: casella disabilitata o senza `gmail.modify`
       (da ricollegare).
     - 409 `draft_changed`: la bozza è cambiata (vedi «Da decidere» 5.2).
     - 409 `mail_not_saved` con `reason` = il codice `DraftError` (es.
       `token_expired`, `google_scope_missing`, `google_unavailable`,
       `account_unavailable`, `attachment_unavailable`): Gmail non l'ha salvata
       neanche ora; `effectFailure` resta `mail_not_saved`.
   - Idempotenza: un riprova su un'azione già salvata risponde 409
     `already_saved` senza toccare Gmail. Due riprova concorrenti possono
     scrivere due volte lo **stesso** testo nella **stessa** bozza (una per
     casella/thread/modo): risultato identico, accettato; l'UPDATE guardato
     `effect_failure IS NOT NULL` ne fa vincere uno solo.
   - Nessun invio, mai (come la conferma). Il registro decisioni non si tocca.
3. Client (`packages/api-client`, gruppo `claude.groups`): `retryEffect(id,
   index): Promise<Reader<ClaudeActionGroupView>>`.

**Cosa farà il renderer**

- `mailNotSavedOf` porta anche `retry?: { groupId, index }` quando
  `canRetryEffect` è vero (`?? false`: un server di prima non lo manda, e il
  pulsante non compare). `model.ts`: `mailNotSaved?: { text: string; retry?:
  { groupId: string; index: number } }`.
- `MailNotSaved`: accanto a «Copia il testo», «Riprova» (solo con `retry`); in
  corsa disabilitato; successo o `already_saved` → invalida i gruppi della
  conversazione e la scheda torna «Fatto»; errore → riga sotto con il testo del
  codice (`mail_forbidden`/`token_expired`/`google_scope_missing` → «ricollega
  la casella», gli altri → il messaggio generico), e «Copia il testo» resta.

**Da decidere**

- 5.1 Testi: il prototipo non ha il «Riprova» di questa scheda. (a) chiave
  nuova `claude.conversation.proposal.retrySave` («Riprova» / «Retry») più
  `retryFailed.<code>`; (b) riusare il `retry` generico e il solo testo
  `mailNotSaved`. **Consiglio (a)**: l'errore del riprova deve dire perché
  (casella da ricollegare ≠ Gmail giù).
- 5.2 Bozza modificata dalla persona fra il fallimento e il riprova (nel
  compositore di Stubwise). Oggi `fillDraftBody` sostituisce il corpo senza
  `baseUpdatedAt`. (a) come la conferma: si sovrascrive il corpo; (b) 409
  `draft_changed` se `mail_drafts.updated_at` della bozza attiva è posteriore a
  `claude_actions.executed_at`. **Consiglio (b)**: il riprova arriva dopo, e
  cancellerebbe in silenzio ciò che la persona ha scritto; il testo resta
  copiabile. Nota: non c'è modo di sapere se nel frattempo la mail è stata
  mandata (gli stati di `mail_drafts` sono solo `active | sending`): in quel
  caso il riprova crea una bozza nuova nel thread — limite da accettare o da
  chiudere lato server.
- 5.3 Indirizzare l'azione: (a) per indice nel gruppo (sopra, nessun campo
  nuovo); (b) aggiungere `id` alle azioni della vista e usare
  `POST /api/claude/actions/:id/retry`. **Consiglio (a)**, a meno che il server
  preferisca esporre l'id per altro.

**Test che il renderer scriverà**

- `claudeChatActions.test.ts`: `effectFailure: "mail_not_saved"` +
  `canRetryEffect: true` → `mailNotSaved.retry` con gruppo e indice;
  `canRetryEffect` assente (server di prima) o `false` → niente `retry`
  (fixture SENZA il campo, apposta).
- `claudeChatActionsPage.test.tsx`: «Riprova» chiama
  `POST /api/claude/groups/<id>/actions/<i>/retry`; 200 → «Fatto»;
  409 `already_saved` → «Fatto»; 409 `mail_not_saved` con `reason:
  "token_expired"` → testo «ricollega» e «Copia il testo» ancora lì; 409
  `draft_changed` → il suo testo; senza `retry` il pulsante non c'è.
- `packages/api-client` (`claude.test.ts`): path e metodo di `retryEffect`.
- `catalogParity.test.ts` invariato (`fillMailBody` resta fuori dal catalogo
  del prototipo).

## 6. A6 — Il ritorno OAuth della casella con stubwise://google

Registro: `docs/plans/integrazione-registro-rimandi.md:438-441` (area 6, F1).
Le righe ~270 e ~416 indicate non parlano di questo tema (r.267-271 sono le
credenziali del worker per il Drive, r.413-417 i riferimenti a Google Drive):
`grep -n "outcome\|deep link\|ritorno"` sul registro trova solo r.438-441.

**Cosa fa il prototipo**

- Esiti del collegamento: `GoogleConnectOutcome = connected | wrong_domain |
  scopes_missing | owned_by_other | failed` (`data/me/types.ts:87-93`), scelti a
  mano nel riquadro «Prototype only» (`pages/preferences/AccountSection.tsx:633-639`,
  `:761-770`). `connectMailbox`/`reconnectMailbox`
  (`data/me/google.ts:52-80`): esito ≠ `connected` → `invalid` col motivo.
- Il dialogo mostra `prefs.google.dialog.errors.<reason>` con ripiego su
  `errors.failed` (`AccountSection.tsx:663-690`); successo → toast
  `prefs.google.dialog.connected` / `reconnected`. Testi (`it.json`):
  `wrong_domain` «Quell'account Google non è su un dominio del Workspace
  scelto…», `scopes_missing` «Alcune autorizzazioni sono state escluse…»,
  `owned_by_other` «Quella casella è già collegata a un altro account
  Stubwise…», `failed` «Collegamento non riuscito. Riprova…»,
  `already_connected`.
- Il prototipo non modella il browser né un ritorno all'app: l'esito arriva
  dalla chiamata stessa.

**Cosa c'è oggi**

- Login desktop (il modello da seguire): `apps/desktop/src/main/browserLogin.ts:1-17`
  — il main genera `state` (+ PKCE), tiene UNA richiesta pendente (5 min), apre
  `<istanza>/app/#/desktop-login?…`; la pagina web, dopo «Allow», fa
  `window.location.assign("stubwise://auth?code=…&state=…")`
  (`pages/entry/DesktopLoginPage.tsx:76-89`); `handleAuthUrl` (`browserLogin.ts:95-140`)
  accetta SOLO `stubwise://auth` con lo state pendente (monouso; state
  sostituiti → `expired`; tutto il resto ignorato senza rete). Il main riceve
  gli URL da `open-url` (macOS) e `second-instance` (Win/Linux), porta la
  finestra davanti e passa a `handleAuthUrl` (`src/main/index.ts:152-160`,
  `:396-420`; `authUrlFromArgv` `browserLogin.ts:145-148`). Al renderer arriva
  solo l'esito (`session:changed`, `preload/index.ts:121-131`). Gli URL esterni
  che il main apre sono solo http(s) (`security.ts:121-129`).
- Adattatore: `connectGoogle` (`data/backend/real/google.ts:84-135`) chiede
  `POST /api/me/google/connect { workspaceId }` → `{ authorizeUrl }`, sul desktop
  `window.open(authorizeUrl, "_blank", "noopener")` (browser di sistema), poi
  **rilegge `accounts()` ogni 3 s** fino a una casella nuova/ricollegata, con
  tetto 10 minuti → `failed`. Nota: il registro dice «rilegge al ritorno in
  primo piano», il codice fa un polling a tempo; non ho trovato un ascolto di
  focus/visibilità. Preferenze → Account (`backend/real/meMailboxes.ts:51-71`)
  riusa `connectGoogle` e trasforma OGNI errore in `reason: "failed"`: oggi
  sul desktop gli esiti `wrong_domain`, `scopes_missing`, `owned_by_other` non
  arrivano mai al dialogo (la persona li legge solo nella scheda del browser,
  sul web vecchio, e l'app aspetta 10 minuti).
- Server: `POST /api/me/google/connect` (`apps/server/src/routes/me-google.ts:192-224`,
  body `googleConnectBodySchema = z.object({ workspaceId })`,
  `packages/shared/src/schemas/google.ts:226`; risposta `{ authorizeUrl }`, `:235`).
  `beginConnect` (`services/google-oauth.ts:178-224`) scrive una riga
  `oauth_states` (nonce, utente, workspace, scadenza 10 min;
  `packages/db/src/schema.ts:5277-5291`) e firma lo `state` (HMAC con la chiave
  d'istanza). `GET /api/me/google/callback` (`me-google.ts:230-268`, pubblico,
  rate limit del login): `error` (consenso annullato) → redirect con `error`
  **senza leggere lo state**; senza code/state → 400; `invalid_state` → 400;
  altrimenti `completeCallback` (`google-oauth.ts:282-311`: verifica,
  consuma il nonce in un UPDATE guardato, scambia il code) e redirect relativo
  `302 /settings/account?google=<esito>` (`me-google.ts:143-149`). Esiti:
  `googleCallbackOutcomes = ok | domain_mismatch | no_refresh_token |
  insufficient_scope | email_not_verified | mailbox_owned_by_other | error`
  (`shared/src/schemas/google.ts:261-271`). Li legge il web vecchio
  (`apps/web/src/components/google-accounts-section.tsx:37`, `:111-121`, banner
  `settings:account.googleAccounts.outcome.<esito>`).

**Contratto**

1. `POST /api/me/google/connect`, body ADDITIVO:
   ```ts
   z.object({
     workspaceId: z.uuid(),
     client: z.enum(["web", "desktop"]).optional(),          // assente = "web"
     returnState: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional(),
   })
   ```
   `client: "desktop"` senza `returnState` → 400 `invalid_request`. Un server
   di prima scarta i campi (z.object li toglie) e si comporta come oggi.
   Risposta ADDITIVA: `{ authorizeUrl, returnTo: z.enum(["web","desktop"]).default("web") }`
   — `"desktop"` solo se il server ha legato il ritorno al desktop. È così che
   il renderer sa se aspettarsi il deep link (un server di prima: `"web"` dal
   default).
2. Legame: `client` e `returnState` stanno sulla riga `oauth_states` di quel
   nonce (colonne nuove nullable, migrazione additiva) o nel payload firmato;
   in ogni caso li decide `beginConnect`, **mai** la query del callback.
3. `GET /api/me/google/callback`:
   - riga del nonce con `client = "desktop"` → `302` verso la pagina
     dell'istanza `/app/#/desktop-google?outcome=<esito>&state=<returnState>`
     (vedi «Da decidere» 6.1), con `<esito>` ∈ `googleCallbackOutcomes`
     (stessi valori di oggi, nessuno nuovo);
   - anche con `error=…` (consenso annullato): se lo `state` è verificabile si
     legge la riga per sapere il client, e l'esito è `error`; se non è
     verificabile, redirect web come oggi;
   - `invalid_state` resta 400 (nessun ritorno all'app: non è un flusso nostro);
   - `client` assente/`"web"` → **invariato** (`/settings/account?google=<esito>`).
4. La pagina `/app/#/desktop-google` (renderer in modo «app» web, servito da
   caddy, nessuna chiamata API, nessuna sessione richiesta) mostra l'esito con i
   testi del dialogo e fa `window.location.assign("stubwise://google?outcome=<esito>&state=<returnState>")`,
   con un pulsante «Torna all'app» per ripeterlo.
5. URL del ritorno: `stubwise://google?outcome=<esito>&state=<returnState>`.
   Contiene SOLO quei due parametri. **Non** contiene: `code` di Google, token,
   lo `state` firmato del server, l'email, l'id della casella o dell'utente.
   L'esito non è un'autorità: chiunque può aprire un `stubwise://google`; il
   renderer conferma `ok` rileggendo `accounts()`.
6. Main di Electron (`browserLogin.ts` o un modulo gemello `googleReturn.ts`):
   - IPC `google:prepare-connect` → `{ state }`: genera `returnState`
     (`randomBytes(16).toString("base64url")`), UNA pendente, scadenza 10 min
     (come lo state del server); una nuova sostituisce la precedente.
   - IPC `google:cancel-connect`: dimentica la pendente.
   - `receiveAuthUrl` smista per hostname: `auth` → `handleAuthUrl` (invariato),
     `google` → `handleGoogleUrl`. In entrambi i casi la finestra torna davanti.
   - `handleGoogleUrl`: accetta solo `outcome` ∈ `googleCallbackOutcomes` e
     `state` = pendente non scaduta; monouso; tutto il resto ignorato (nessun
     avviso). Invia al renderer `google:returned` `{ state, outcome }`.
   - `preload`: `google.prepareConnect()`, `google.cancelConnect()`,
     `google.onReturned(cb) → unsubscribe`.
7. Web (`build:web`, `/app`, e web vecchio): non manda `client`; nulla cambia.
8. Compatibilità: desktop vecchio → nessun `client` → redirect web come oggi;
   desktop nuovo con server vecchio → `returnTo: "web"` → polling come oggi;
   app mobile: non tocca `/connect`.

**Cosa farà il renderer**

- In `connectGoogle`, solo se `window.stubwise?.google` esiste: `prepareConnect()`,
  poi `connect(workspaceId, { client: "desktop", returnState })`.
- Con `returnTo === "desktop"`: aspetta `google:returned` col proprio `state`
  **e** tiene il polling a 3 s come rete (deep link rifiutato dal browser,
  scheda chiusa). Al ritorno: `outcome === "ok"` → rilegge `accounts()` una
  volta e risolve con la casella nuova/ricollegata (se non c'è ancora,
  continua il polling); esito negativo → smette di aspettare e rifiuta con il
  motivo mappato sui valori del prototipo:
  `domain_mismatch → wrong_domain`, `insufficient_scope → scopes_missing`,
  `mailbox_owned_by_other → owned_by_other`,
  `no_refresh_token | email_not_verified | error | ignoto → failed`.
- `meMailboxes.ts` smette di appiattire tutto su `failed`: passa il motivo
  (`{ ok: false, error: "invalid", reason }`), così il dialogo mostra
  `prefs.google.dialog.errors.<reason>` come nel prototipo.
- Chiusura del dialogo durante l'attesa → `cancelConnect()`.

**Da decidere**

- 6.1 Dove porta il callback: (a) una pagina dell'istanza
  (`/app/#/desktop-google`) che dice l'esito e apre `stubwise://google`, come fa
  `/app/#/desktop-login`; (b) `302` diretto a `stubwise://google?…`.
  **Consiglio (a)**: con (b) la scheda resta bianca (o con un errore del
  browser se l'app non c'è), e la persona non vede l'esito; (a) è lo stesso
  schema del login.
- 6.2 Consenso annullato su Google: (a) resta `error` (nessun valore nuovo
  nell'enum condiviso, che il web vecchio legge); (b) un valore nuovo
  `cancelled`, solo per il ritorno desktop, che il renderer tratta come
  «niente da dire» (chiude l'attesa senza errore). **Consiglio (a)** per
  questa fetta: un enum condiviso che cresce va aperto anche nel banner del
  web; (b) si può aggiungere dopo.
- 6.3 Nuova riga del registro: l'esito della scheda del browser sul desktop
  oggi è nel web vecchio (`/settings/account`); con (a) la persona lo vede
  nella pagina nuova. Da segnare che le chiavi `settings:account.googleAccounts.outcome.*`
  del web non servono al desktop.

**Test che il renderer scriverà**

- `src/main/googleReturn.test.ts` (o in `browserLogin.test.ts`):
  `stubwise://google` con lo state pendente → un `google:returned`
  `{ state, outcome }`; state sconosciuto, scaduto, già usato, `outcome` fuori
  dall'elenco, parametri in più ignorati, hostname diverso → nulla; una nuova
  `prepareConnect` invalida la precedente; `stubwise://auth` va ancora a
  `handleAuthUrl` (smistamento).
- `data/backend/real/google.test.ts`: con `window.stubwise.google` manda
  `client: "desktop"` e `returnState`; senza (web) il body è solo
  `{ workspaceId }`; `returnTo` assente nella risposta (server di prima,
  fixture SENZA il campo) → solo polling; ritorno `ok` → una lettura di
  `accounts()` e risolve; ritorno `domain_mismatch` → rifiuta con
  `wrong_domain` senza aspettare il tetto; esito ignoto → `failed`; deep link
  mai arrivato → il polling chiude comunque.
- `meMailboxes` (o la pagina Preferenze in build app): un rifiuto
  `owned_by_other` arriva al dialogo come `prefs.google.dialog.errors.owned_by_other`.
- Pagina `desktop-google`: mostra il testo dell'esito e chiama
  `window.location.assign("stubwise://google?outcome=…&state=…")` con i soli due
  parametri; `outcome` ignoto → testo `failed`.

## 7. A3 — Le sessioni di Claude e i report

Percorsi del renderer relativi a `apps/desktop/src/renderer/`. Regola comune: ogni
campo nuovo è additivo (`.default()`/`.optional()`/`.nullable()`) negli schemi di
`packages/shared`, e ogni id di persona passa dalla maschera «chi si conosce»
(`apps/server/src/services/people-known.ts`, `registerPersonMask`): chi guarda e
non conosce la persona riceve `hidden-<n>`, e il `…Name` accanto a un `…Id`
mascherato diventa `null`.

### 7.1 Chi ha avviato e chi ha risposto (r.38)

**Cosa fa il prototipo**
- `Conversation.ownerId` (`data/model.ts:1087`): «sessione di lavoro: chi l'ha chiesta».
  Lo leggono la nota della domanda per chi non può rispondere,
  `QuestionCard.tsx:48,65,69` («{{name}} or someone who can approve plans in {{code}} can answer»,
  `claude.conversation.question.whoCanAnswer`/`ownerAnswers`), e la riga del refinement
  `pages/requests/RefineView.tsx:433` (`requests.refine.startedBy`, «Refinement · started by {{name}}»).
- Risposta a una domanda: `answer: { optionIndex, text, byId, at }` dell'evento `question`
  (`data/model.ts:1361`). `QuestionCard.tsx:106-136` mostra «Answered by {{name}}: <scelta> · <ora>»
  (`claude.conversation.question.answeredBy`) e, dopo un 409, «Already answered by {{name}}»;
  la storia del lavoro `pages/task/WorkStory.tsx:98` dice «Answered by {{name}}: {{label}}»
  (`taskDetail.claude.story.answer`).
- «Run started by {{name}}» (`WorkStory.tsx:40-44`) usa `run.ownerId` di `/work`.
- Le righe dell'elenco mostrano «by {{name}}» solo con `ownerName` (`ConversationList.tsx:425`),
  che il prototipo non dà alle sessioni di lavoro: in elenco il nome non si vede.

**Cosa c'è oggi**
- `GET /api/tasks/:id/work` dà già `runs[].ownerId` (`ai_jobs.requested_by_user_id`,
  `apps/server/src/services/task-work.ts:204`), mascherato (`TASK_PERSON_KEYS`,
  `routes/tasks.ts:106`); l'adattatore lo usa (`data/backend/real/claude.ts:698`).
  «Run started by» quindi funziona già.
- La sessione (`agentSessionSummarySchema`, `packages/shared/src/schemas/agent-session.ts:249`)
  non porta chi l'ha avviata: `toRow` mette `ownerId: ""` (`real/claude.ts:147`), e così
  `real/claudeRefine.ts:46`.
- `agentSessionQuestionSchema` (`agent-session.ts:330`) ha `answered`/`answer`, ma non chi né
  quando: `packages/shared/src/claude/session-events.ts:92-93` scrive `byId: ""`, `at: ""`.
  Le colonne ci sono: `agent_questions.answered_by_user_id` e `answered_at`
  (`packages/db/src/schema.ts:4845-4850`).
- Chi ha avviato: `ai_jobs.requested_by_user_id` (job AI) e
  `backlog_refine_sessions.started_by_user_id` (refinement, `schema.ts:4085`). Per review PR,
  Docs, brief, daily report, intake e posta non ho trovato colonne: nessuna persona.
- Le rotte `/api/agent-sessions` NON registrano la maschera delle persone
  (`routes/agent-sessions.ts`, nessun `registerPersonMask`), e lo stream
  (`GET /:id/stream`) scrive a mano con `reply.raw.write` (`:196`), quindi un hook
  `preSerialization` lì non scatterebbe.

**Contratto**
- `agentSessionSummarySchema` (elenco, dettaglio e messaggio `session` dello stream), campo nuovo:
  `startedById: personRefSchema.nullable().default(null)`. Il server lo deriva da
  `ai_jobs.requested_by_user_id` per `ai_job`, da `backlog_refine_sessions.started_by_user_id` per
  `backlog_refine`, e lo lascia `null` per gli altri kind (sessioni automatiche) e per un utente
  eliminato (`ON DELETE SET NULL`). Nessuna migrazione.
- `agentSessionQuestionSchema`, campi nuovi:
  `answeredById: personRefSchema.nullable().default(null)` (da `answered_by_user_id`) e
  `answeredAt: z.iso.datetime().nullable().default(null)` (da `answered_at`). Tutti e due `null`
  su una domanda aperta o annullata (`cancelled`).
- Privacy: `startedById` e `answeredById` passano da `hiddenFor` + `maskPeople` sia nelle risposte
  JSON (`registerPersonMask(app, new Set(["startedById","answeredById"]))` sul plugin delle
  sessioni) sia nel messaggio `session` dello stream, che si maschera a mano prima della `send`.
  Non si aggiungono nomi: il renderer li risolve dalle persone che conosce, come fa con
  `run.ownerId` di `/work`.
- Permessi ed errori: invariati. Chi vede la sessione (`repos.view`, o `backlog.edit` per il
  refinement) vede anche questi campi; una sessione invisibile risponde 404 come oggi.
- Fuori da questa voce, da segnalare: `inputs[].authorName` è l'email e non passa dalla maschera
  (`services/agent-sessions.ts`, `emailsOf`). Chi scrive in una sessione è quasi sempre conosciuto
  (membro o full admin), ma la regola non è applicata.

**Cosa farà il renderer**
- `toRow` usa `ownerId: s.startedById ?? ""` (sessioni e refinement); nessun `ownerName` per le
  sessioni (in elenco il prototipo non mostra il nome).
- `session-events.ts` (`questionOf`) usa `byId: q.answeredById ?? ""` e `at: q.answeredAt ?? ""`;
  `WorkStory` e `QuestionCard` lo prendono da sé. Un segnaposto `hidden-<n>` non si risolve fra le
  persone e la riga dice «someone», come oggi per `run.ownerId`.

**Test che il renderer scriverà**
- `data/backend/real/claude.test.ts`: `startedById` → `ownerId`; senza campo (server vecchio) → `""`;
  `hidden-3` → la nota della domanda senza nome.
- `packages/shared/src/claude/session-events` (test accanto): `answeredById`/`answeredAt` arrivano in
  `answer.byId`/`at`; senza campi restano `""`.
- `real/claudeSessionPage.test.tsx`: «Answered by Marco: … · 10:42» con il dettaglio e dopo un
  messaggio `session` dello stream.
- `real/claudeRefine.test.ts`: «started by» col nome di chi l'ha avviata.

### 7.2 Piano e digest nel dettaglio (r.33)

**Cosa fa il prototipo**
- Il piano è un evento del flusso, `type: "plan"` (`data/model.ts:1376-1404`): `planText`, `summary`,
  `status` (`pending|approved|rejected|pre_approved|undecided`), `decidedById`, `instructions` e,
  solo nella build app, `digest`.
- `PlanCard.tsx:170-185` rimanda `planDigest: event.digest` ad approve/reject; con un 409
  `plan_changed` mostra «changed». Decide solo chi ha `canDecidePlan` (`real/claude.ts:486-529`,
  da `waitsOnViewer` del server). Il piano lo legge chiunque veda la sessione: il prototipo non
  nasconde il piano, né il digest, a chi non può decidere.

**Cosa c'è oggi**
- Il dettaglio della sessione non porta il piano. L'adattatore lo prende da
  `GET /api/tasks/:id/work` (`planOf`/`readPlan`, `real/claude.ts:250-275`, `runs[].plan`
  con `digest`, `packages/shared/src/schemas/task-view.ts:323-343`), con una cache sulla firma
  del dettaglio: una lettura in più per ogni sessione aperta, e nello stream il piano si
  aggiorna solo quando la firma cambia.
- Il server calcola piano e stato in `loadTaskWorkExtras` (`services/task-work.ts:186-226`):
  `plan_text`, `plan_summary`, `planStatus` (registro `plan_review` con `mode: "execute"`, job
  eseguito, pre-approvazione con digest uguale) e `planDigest(plan_text)`. Approve/reject
  accettano `planDigest` e rispondono 409 `plan_changed` (`routes/tickets.ts:1683-1730`).

**Contratto**
- `agentSessionDetailSchema` (dettaglio e messaggio `session` dello stream), campo nuovo:
  `plan: z.object({ jobId: z.uuid(), text, summary, status, at, digest: z.string().nullable().default(null) }).nullable().optional()`,
  con `status` e la forma di `taskWorkRunSchema.plan`.
  - **assente** = server che non lo sa dare (il renderer torna a `/work`);
  - `null` = nessun piano (kind diverso da `ai_job`, o job senza `plan_text`, anche dopo un rifiuto,
    che lo azzera);
  - oggetto = il piano del job della sessione (`agent_sessions.ai_job_id`).
- Il server lo deriva con LA STESSA funzione di `/work`: si estrae `planStatus` + digest da
  `task-work.ts` in una funzione condivisa, così le due letture non divergono. Nessuna migrazione.
- Digest e permessi: il digest va a **chiunque veda la sessione** (`repos.view`), come oggi in
  `/work`. È l'hash di un testo che chi guarda già legge, quindi non rivela nulla, e decidere resta
  dietro `plans.approve` sulle rotte approve/reject (e nei servizi, «I due divieti
  dell'operatore»). Il client non deduce chi decide: continua a leggere `waitsOnViewer`.
- Errori: nessuno nuovo. Approve/reject restano quelli di oggi (409 `plan_changed` col digest).
- Non in questa voce: `decidedById`/`instructions` del piano non arrivano né da `/work` né qui
  («Approved by {{name}}» della scheda resta senza nome). Va registrato a parte se serve.

**Cosa farà il renderer**
- `planOf(detail)`: se `detail.plan` c'è (anche `null`), lo usa senza chiamare `tasks.work`; se manca
  il campo, fa la lettura di oggi. L'evento piano mantiene l'id `plan:<jobId>`.
- `signatureOf` include `plan?.digest`, così un piano riscritto nello stream sostituisce la scheda.

**Test che il renderer scriverà**
- `real/claude.test.ts`: con `plan` nel dettaglio, `tasks.work` non è mai chiamato (spia) e l'evento
  porta il digest; `plan: null` vuol dire nessuna scheda, senza lettura; senza campo si usa
  `/work` come oggi.
- `real/claudeSessionPage.test.tsx`: approva → `approvePlan` col `planDigest` del dettaglio; un
  messaggio `session` con un digest nuovo cambia la scheda; 409 `plan_changed` → «changed».

### 7.3 usage e blocked in /work (r.40)

**Cosa fa il prototipo**
- `TaskWork.usage: ModelUsage[]` (`data/types.ts:243-249`; `ModelUsage` in `data/model.ts:624`:
  `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `costUsd` in USD). Si somma per modello
  su TUTTE le sessioni di lavoro della task, senza periodo (tutta la vita della task), ordinato dal
  costo più alto (`data/api.ts:1271-1295`, `usageOfTask`). Lo vede chi vede la task, anche senza
  vederne le sessioni (`ClaudeSection.tsx:457-458`, accanto a `hiddenRuns`).
  `UsageDisclosure` (`pages/task/ClaudeRunParts.tsx:281`): «AI usage · {{tokens}} tokens · {{cost}}»
  e per modello «In {{input}} · out {{output}} · cache {{cache}}» (`taskDetail.claude.usage.*`).
  Vuoto: niente riga.
- `TaskWork.blocked: AiBlock | null` (`data/types.ts:250-256`; `AiBlock` in `data/model.ts:619`):
  `{ reason: "monthly_budget" }` oppure `{ reason: "queue_paused", byId, byName, since }`. Lo
  calcola `aiBlockFor(projectId)` (`data/instance/blocks.ts:152`): il budget del mese vince ovunque,
  la pausa vale per il progetto, indipendentemente dallo stato del lavoro. UI
  (`ClaudeSection.tsx:441,476-487,610-612`, `components/InstanceBlock.tsx:95-122`): con il budget
  il bottone Start è spento e la riga dice «The monthly AI budget is used up. New work waits until
  someone raises it.» (`instanceEffects.budget.start`); con la pausa Start resta acceso e la riga
  dice «{{code}}'s queue is paused by {{name}} {{since}}. If you start now, Claude waits for it to
  resume.» (`instanceEffects.queue.start`). L'attesa di UNA sessione è un'altra cosa:
  `TaskRun.waiting` (`data/types.ts:185`).

**Cosa c'è oggi**
- I consumi esistono come rotta a parte: `GET /api/tickets/:ticketId/usage`
  (`apps/server/src/routes/ai-jobs.ts:174-197`, `aggregateUsage`: `agent_runs` ⋈ `ai_jobs`
  sul ticket, per modello, `costUsd` **nullable**, ordinato per modello), accesso: chi vede il
  ticket (R6). `packages/api-client` non la espone e `/work` non ha `usage`: l'adattatore mette
  `usage: []` (`real/claude.ts:755-756`).
- `taskWorkViewSchema.blocked` esiste già (`task-view.ts:443-450`). Il server lo valorizza solo con
  `queue_paused` e solo se l'ULTIMO job è `queued` su una coda in pausa (`task-work.ts:365-372`,
  `queuedJobBlock` in `services/instance-status.ts:89`), cioè l'attesa della sessione, non il
  blocco degli avvii. Il docblock in `task-work.ts:47` («sempre `null`») è vecchio. L'adattatore
  lo ignora (`blocked: null`, `real/claude.ts:757-758`), e mette pure `waiting: null` sui run.
- Budget: un avvio a mano lo scavalca (`manualTrigger: true` in `services/jobs.ts:274`,
  `checkBudgetsBeforeRun` in `apps/worker/src/pipeline/job-outcomes.ts:225`). Sul server vero Start
  col budget finito **parte**, mentre il prototipo lo rifiuta.
- `byId` di `blocked` passa dalla maschera di `/work` (`byId` ∈ `TASK_PERSON_KEYS`), e `byName`
  diventa `null` se l'id è mascherato (`maskPeople`); lo schema ha già `byName` nullable.

**Contratto**
- `taskWorkViewSchema`, campo nuovo:
  `usage: z.array(z.object({ model: z.string(), inputTokens: z.number().int(), outputTokens: z.number().int(), cacheReadTokens: z.number().int(), costUsd: z.number().nullable() })).default([])`.
  Lo stesso conto di `aggregateUsage` (estratto in un servizio, così `/usage` e `/work` non
  divergono), ordinato per `costUsd` decrescente, `null` in fondo, poi per `model`. Unità: token
  interi e USD. Periodo: tutta la task. Visibilità: chi vede la task (accesso `onTicket()` della
  rotta), **anche** quando `runs` è vuoto per `repos.view`, come il prototipo.
- `blocked` (campo esistente, stessa forma): diventa il blocco degli AVVII NUOVI del progetto
  della task, indipendente dallo stato del lavoro: `queue_paused` quando
  `projects.queue_paused_at` non è null (`queuePauseOf`), con `byId` (mascherato), `byName`
  (`null` se mascherato) e `since`. Per `monthly_budget` vedi «Da decidere».
- `taskWorkRunSchema`, campo nuovo: `waiting: <la stessa forma di blocked>.nullable().default(null)`,
  cioè quello che oggi il server mette in `blocked` (`queuedJobBlock` del job del run). Il
  significato di prima si sposta sul run, dove sta nel prototipo.
- Errori: nessuno nuovo su `/work`.

**Cosa farà il renderer**
- `getTaskWork`: `usage` dalla vista (`costUsd: null` → 0, vedi «Da decidere»), ordinato come
  arriva; `blocked` dalla vista (`byId ?? ""`, `byName ?? ""`); `runs[i].waiting` dalla vista. Non
  usa `/api/tickets/:id/usage`.

**Da decidere**
- ✅ **Deciso (D-7.1, maintainer): (b)**, la regola del prototipo. Il testo sotto resta per la storia.
- `monthly_budget` in `blocked`: (a) il server non lo manda finché un avvio a mano scavalca il
  budget (la riga e il bottone spento direbbero una cosa falsa); (b) il server lo manda E `startRun`
  rifiuta con 409 `budget_exhausted` come il prototipo (e come dice
  `admin.ai.budget.waits`) — è un cambio di comportamento, non solo di contratto, e tocca la regola
  E7 («un maintainer scavalca il budget»). **Consiglio (a)** in questo lotto, con (b) registrato
  come decisione di prodotto.
- `costUsd` null (run di un CLI vecchio senza costo): (a) il server lo manda `null` e il renderer
  lo somma come 0; (b) il server manda 0. **Consiglio (a)**: il dato resta onesto e la UI del
  prototipo non cambia.

**Test che il renderer scriverà**
- `real/claude.test.ts` (`getTaskWork`): `usage` mappato e ordinato; `costUsd: null` → 0 nel totale;
  senza campo → `[]`. `blocked` `queue_paused` con `byName: null` (persona mascherata) → riga senza
  nome; `blocked: null` → nessuna riga; `runs[].waiting` mappato.
- `real/taskPanel.test.tsx`: «AI usage · … tokens · $…» con `hiddenRuns: true` e `runs: []`; con la
  coda in pausa la riga `instanceEffects.queue.start` e Start acceso.

> **Nota di 94 su `blocked`.** Cambiare il significato di un campo che c'è
> già non è additivo in generale. Qui è sicuro perché `/work` lo legge solo il
> desktop (nessun riferimento in `apps/web` né in `apps/mobile`), e oggi
> l'adattatore lo ignora (`real/claude.ts:758`, `blocked: null`). Il
> significato di oggi passa a `runs[].waiting` nello stesso rilascio.

### 7.4 generatedAt dei report (r.42)

**Cosa fa il prototipo**
- `DailyReport.generatedAt: string | null` (`data/model.ts:538-550`): quando è stato scritto;
  `null` = non si sa. Serve SOLO a contare i commit arrivati dopo (`commitsAfterReport`,
  `data/api.ts:1507-1515`) → `DailyReportView.newCommits` (`data/types.ts:210-214`) →
  «{{count}} new commits not included» (`projects.people.report.stale_*`,
  `pages/projects/PeopleActivity.tsx:370,706,756`). Non l'ho trovato mostrato come data in nessuna
  pagina.

**Cosa c'è oggi**
- `GET /api/activity?date=` (`apps/server/src/routes/activity-routes.ts:149`, `repos.view` per
  progetto, ruling R49) dà `status`, `summary`, `staleCommitCount`; schema client
  `activityReportProjectSchema` (`packages/shared/src/schemas/activity.ts:18-28`). Niente
  `generatedAt`: l'adattatore mette `generatedAt: null` (`real/peopleActivity.ts:58-77`) e prende
  `newCommits` da `staleCommitCount`, che il server già calcola.
- La colonna c'è: `activity_reports.finished_at`, scritta a `done` e a `failed` dal worker
  (`apps/worker/src/reports/daily-report-poller.ts:838,890`) e azzerata alla ripresa
  (`:583,654`). Il `force` di `POST /api/activity/generate` rimette `queued` senza azzerarla
  (`activity-routes.ts:554`).

**Contratto**
- In ogni voce di `projects[]` di `GET /api/activity` (schema della rotta e
  `activityReportProjectSchema`): `generatedAt: z.iso.datetime().nullable().default(null)` =
  `finished_at` quando `status === "done"`, altrimenti `null` (in coda, in scrittura, fallito, o
  `finished_at` vecchio di un `force`). Nessuna migrazione, nessun permesso nuovo (resta
  `repos.view`), nessun errore nuovo. `staleCommitCount` resta la fonte del conteggio.

**Cosa farà il renderer**
- `listDailyReports`: `generatedAt: p.generatedAt ?? null`; `newCommits` resta `staleCommitCount`
  (non lo ricalcola dai commit). Oggi la differenza non si vede in pagina: il campo c'è perché la
  forma è quella del prototipo.

**Test che il renderer scriverà**
- `real/peopleActivity.test.ts`: `generatedAt` passa per un report `done`; `null` per `failed` e
  `pending`; senza campo (server vecchio) → `null`, e `newCommits` sempre da `staleCommitCount`.
