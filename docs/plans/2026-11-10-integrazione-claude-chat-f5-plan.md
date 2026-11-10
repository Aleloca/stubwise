# Chat con Claude, fetta 5 — conversazioni pubbliche e continuazione — piano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.
>
> Stato: **bozza per il maintainer**. Le decisioni marcate **[DECIDE]** vanno
> prese prima del codice; per ognuna c'è la raccomandazione. Autore:
> stubwise-72, per l'orchestratrice.

**Spec**: il prototipo (la fonte del comportamento):
- `data/model.ts` (campi della conversazione);
- `data/store.ts` (`canSeeConversation`, `conversationRow`,
  `readableLength`, `canContinue`);
- `data/api.ts` (`listConversations`, `resolveCitations`, `resolveCodes`,
  `originOf`);
- `data/api-mutations.ts` (`projectsOfSteps`, `touchProjects`, `releaseHold`,
  `setVisibility`, `continueConversation`, `checkOpenProposal`);
- `data/claude/context.ts` (`presentEventFor`), `pages/claude/**`
  (`PublishDialog`, `ContinueBanner`, `HiddenCode`), `data/access/seed.ts`;
- i test `data/conversations.test.ts:492-855`.

Shape: `apps/desktop/.impeccable/shape/claude-{destination,actions,scenarios}.md`.
Design area 3 §2 e §5 (`docs/plans/2026-10-24-desktop-area3-claude-design.md`);
design della chat (`docs/plans/2026-11-10-integrazione-claude-chat-design.md`,
fetta 5, «maintainer: dopo»).

**Base**: fette 1–3 (`apps/desktop/docs/integration-claude-chat.md`).
Registro: «Conversazioni pubbliche e continuazione»
(`docs/plans/integrazione-registro-rimandi.md`). Invarianti:
`docs/invariants/{agent-sessions,permissions,second-factor}.md`.
Migrazioni: dalla **0133** (la 0132 è la riconferma dal desktop; da
riverificare sui branch prima di scriverla).

## Il punto delicato: Claude ha letto PER CONTO dell'autore

In una conversazione privata Claude legge con i permessi dell'autore (il
token del turno). Rendere pubblica la conversazione espone a chi ha
`claude.public.view` tre cose:
1. i **messaggi dell'autore**;
2. le **risposte di Claude**, prosa scritta su dati che solo l'autore vedeva;
3. gli **eventi dei tool**, cioè le letture: `tool_use` con gli argomenti e
   `tool_result` col JSON letto dal server, salvati in `agent_session_events`.

Il prototipo regge così:
- la pubblicazione chiede all'autore di confermare i progetti «letti o
  toccati» («Make public, I'm responsible»);
- le citazioni si risolvono come chi guarda (R-G5: il codice resta, non si
  apre);
- se Claude tocca un progetto nuovo, il seguito resta privato
  (`privateFromIndex`) finché l'autore non riconferma.

Il prototipo non ha il punto 3, perché i tool sono finti. Sul server vero il
3 è il buco più grande: un `tool_result` contiene campi che la prosa non
cita. La raccomandazione è che **gli eventi dei tool non escano mai
dall'autore** (D1).

## Global Constraints

1. **La conversazione resta dell'autore.**
   - Solo l'autore scrive, pubblica, rende privata, archivia ed elimina.
   - Chi la vede da pubblica la legge e basta: niente casella, niente
     risposte alle schede, niente conferme né «Annulla».
   - Chi vuole proseguire **continua**: una conversazione NUOVA, privata,
     sua.
2. **La visibilità la decide il SERVER, nella WHERE**, come oggi
   (`docs/invariants/permissions.md`, «Gli elenchi filtrano nella WHERE»):
   - una pubblica la vede chi ha `claude.public.view`;
   - una non visibile risponde 404 come una che non esiste;
   - i full admin non hanno eccezioni sulle private: una privata resta
     dell'autore (invariante delle fette 1–2).
3. **Ciò che un lettore non-autore riceve è una PROIEZIONE fatta dal server**
   (eventi, stream, proposte, gruppi), mai il dato dell'autore filtrato dal
   client. Il client legge i permessi e le viste calcolati dal server.
4. **R-G5**: un codice di un oggetto che chi legge non vede resta testo, non
   si apre, e non dice se l'oggetto esiste.
   - Invisibile e inesistente si leggono uguali.
   - Il testo salvato non si riscrive (la prosa di Claude resta com'è): si
     proietta a lettura.
5. **Il seguito privato è per costruzione.** In una pubblica, gli eventi di un
   turno arrivano ai lettori non-autori solo a turno finito, e solo se il
   turno non ha toccato progetti nuovi. Altrimenti si fermano al primo evento
   di quel turno (il messaggio dell'autore compreso), finché l'autore non
   riconferma. Questo vale anche per lo stream dal vivo.
6. **La continuazione è dell'utente che continua**:
   - il token del turno è il suo;
   - Claude legge e propone con i suoi permessi;
   - l'originale non diventa mai un canale per leggere come l'autore.
7. **Additivo verso i client** (`CLAUDE.md`): ogni campo nuovo nasce con
   default; i valori di enum nuovi passano da `readerSchema`; nel web vecchio
   si difendono a lettura.
8. **Golden**: si tocca il prompt (la continuazione), quindi si girano i
   golden della chat sul CLI pinnato, coordinati con stubwise-94. Uno
   scenario rosso NON si aggiusta forzando il prompt.

## Decisioni per il maintainer

- **[DECIDE] D1 — gli eventi dei tool in una pubblica.**
  - **(a, consigliata)** Ai non-autori i `tool_use` arrivano col solo nome del
    tool (niente argomenti) e i `tool_result` senza contenuto. Se il renderer
    li mostra, si vede «Claude ha letto (2)», non cosa.
  - (b) Si tolgono del tutto.
  - (c) Restano come per l'autore, cioè col JSON letto con i suoi permessi:
    non consigliata, è il buco.
- **[DECIDE] D2 — quali progetti sono «letti o toccati»** (l'elenco della
  conferma e il trigger del seguito privato).
  - **(a, consigliata)** Il server li ricava da ciò che SA:
    - il progetto di ogni oggetto letto per codice o per id dal token del
      turno (`read_task`, `read_request`, i docs, il brief, `search_tasks`
      con un progetto);
    - il progetto di ogni codice citato nella risposta;
    - il progetto di ogni azione proposta o eseguita;
    - il contesto della pagina.

    Gli elenchi generici (`list_projects`, `list_people`, `search_tasks`
    senza progetto) contano solo per ciò che la risposta cita.
  - (b) Come il prototipo: solo citazioni e azioni (una lettura non citata
    non conta).
  - (c) Ogni progetto apparso in qualunque risultato: prudente ma rumoroso
    (`list_projects` li segnerebbe tutti).
- **[DECIDE] D3 — cosa sa Claude in una continuazione.**
  - **(a, consigliata)** Il primo prompt della continuazione porta come
    contesto NON FIDATO la trascrizione LEGGIBILE dell'originale: i messaggi
    e le risposte fino al punto privato, proiettati come li legge chi
    continua (D1, R-G5), senza eventi dei tool. Sono cose che chi continua
    vede già: nessuna lettura nuova.
  - (b) Come il prototipo: la continuazione nasce vuota, e Claude non sa di
    cosa si parlava. Fedele, ma col CLI vero è poco utile.
- **[DECIDE] D4 — chi ha `claude.public.view`.** È un permesso d'istanza nuovo
  nel registro condiviso (`INSTANCE_PERMISSIONS`).
  - **(a, consigliata)** Come il prototipo: i preset d'istanza User e Admin
    (il full admin lo ha implicito), con una migrazione che lo dà ai ruoli
    esistenti basati su quei preset.
  - (b) A nessuno: si assegna con un ruolo.
- **[DECIDE] D5 — una pubblica e la potatura dei 14 giorni.** Oggi una libera
  inattiva da 14 giorni si pota con le trascrizioni del CLI.
  - **(a, consigliata)** Vale anche per le pubbliche: le continuazioni restano
    con «The original conversation is no longer available».
  - (b) Una pubblica non si pota finché è pubblica.
- **[DECIDE] D6 — l'autore nella riga di «Public».**
  - (a) Come il prototipo: la riga non lo dice, lo dice la testata («made
    public by X»).
  - **(b, consigliata)** Anche la riga lo dice: chi sceglie da un elenco di
    conversazioni altrui vuole sapere di chi sono.
- **Prese dal prototipo, se il maintainer non dice altro:**
  - letti e toccati non si distinguono nel dialogo;
  - «Make private» si può, e azzera la pubblicazione;
  - archiviata = fuori da Public, ma il link resta aperto;
  - eliminare una pubblica lascia le continuazioni altrui con l'origine
    «gone»;
  - nessuna notifica per pubblicazione o continuazione;
  - le proposte e i gruppi si vedono, ma decide solo chi li ha chiesti (già
    così sul server).

## Review Focus

1. **Una privata che si legge**: ogni rotta che porta eventi, messaggi,
   proposte, gruppi, stream o il titolo filtra nella WHERE con la stessa
   regola. Una privata altrui è 404, anche per un full admin.
2. **La proiezione per i non-autori**:
   - niente argomenti né risultati dei tool;
   - codici invisibili come testo;
   - il contesto della pagina invisibile a null;
   - le proposte senza dati di oggetti invisibili, e niente bottoni.
3. **Il seguito privato dal vivo**: lo stream di un non-autore non riceve gli
   eventi di un turno in corso, né quelli di un turno che ha toccato un
   progetto nuovo. Una riconferma li rilascia, e solo i progetti nuovi
   compaiono nel dialogo.
4. **La continuazione**:
   - il token del turno è di chi continua;
   - un codice dell'originale che lui non vede è «non visibile» anche per
     Claude;
   - la trascrizione dell'originale nel prompt è quella leggibile da lui,
     mai quella dell'autore.
5. **La pubblicazione**: si pubblica solo se i progetti confermati coincidono
   con quelli di adesso (una conferma vecchia è 409). Solo l'autore.
6. **Additività**: un client vecchio con una conversazione pubblica non si
   rompe, e un server vecchio tratta tutto come privato.

## F5.1 (DB + shared)

- **Migrazione 0133**:
  - `claude_conversations` riceve:
    - `visibility` (`private`|`public`, default `private`, con CHECK);
    - `published_at`, `published_by`;
    - `published_project_ids` (uuid[], i progetti confermati);
    - `private_from_event_id` (bigint/uuid nullable: il primo evento NON
      rilasciato ai lettori);
    - `continues_from_session_id` (FK SET NULL).
  - Tabella `claude_conversation_projects(session_id, project_id,
    first_event_id)`: i progetti letti o toccati (D2), scritti dal server.
  - Il permesso `claude.public.view` ai preset (D4).
- **Shared**:
  - `claude.public.view` in `INSTANCE_PERMISSIONS`, con le etichette i18n del
    web e il test del catalogo;
  - schemi additivi della conversazione: `visibility`, `publishedAt`,
    `publishedBy`, `publishedProjects` (codice e nome visibili a chi
    guarda), `privateTail` (per il non-autore), `continuesFrom` (`{ id,
    available }`), `canPublish`, `canContinue`, `canWrite` (già c'è);
  - corpo di `POST …/visibility` e la risposta `needs_confirmation`;
  - `scope` della lista: `mine | public`.
- **Test**: parse senza i campi nuovi (client vecchio contro server vecchio),
  e il catalogo dei permessi.

## F5.2 (server: visibilità, proiezione, seguito privato)

- **Chi vede** (`claude-conversations.ts`, `agent-sessions.ts`):
  - la regola sta in UN posto (`canSeeConversation`): autore, oppure
    `public` e `claude.public.view`;
  - la usano lista, dettaglio, eventi, stream, messaggi, proposte e gruppi;
  - le rotte d'istanza delle sessioni continuano a non mostrare le `free`.
- **Progetti letti o toccati** (D2): il server li scrive in
  `claude_conversation_projects`:
  - alle letture del token del turno (le rotte di `CHAT_TOOL_READ_ROUTES` per
    codice o per id: il progetto è già risolto dall'accesso della rotta);
  - alla fine del turno, dai codici citati nella risposta;
  - a ogni proposta.

  Nessun dato letto si salva: solo `project_id` e l'evento del turno.
- **Il seguito privato**: a ogni messaggio dell'autore in una pubblica,
  `private_from_event_id` = l'evento `input` di quel messaggio (trattenuto).
  - Alla fine del turno, se i progetti del turno sono tutti in
    `published_project_ids`, il server rilascia (`private_from_event_id` =
    null).
  - Altrimenti resta, e l'autore vede la fascia con i progetti nuovi.
  - La riconferma (`POST …/visibility` con i progetti nuovi confermati)
    rilascia.
  - Domande e piani dal seguito privato non arrivano a nessun altro.
- **La proiezione** per il non-autore, in un modulo solo (`publicView.ts`):
  - eventi fino a `private_from_event_id`;
  - D1 sugli eventi dei tool;
  - i codici nel testo marcati come visibili o no per chi guarda (R-G5, come
    `resolveCodes` di oggi);
  - il contesto della pagina invisibile a null;
  - le proposte e i gruppi senza argomenti di oggetti invisibili, con
    `canConfirm/canCancel/undo` = false (`not_yours`).

  Lo stream SSE passa dalla stessa proiezione: per un non-autore gli eventi
  di un turno in corso non partono.
- **Rotte**:
  - `GET /api/claude/conversations?scope=public`: le pubbliche di altri, non
    archiviate, per `updated_at` del rilascio, cioè il seguito privato non fa
    salire la riga;
  - `POST /api/claude/conversations/:id/visibility` `{ visibility,
    confirmedProjectIds }`: solo l'autore. La prima chiamata risponde 409
    `needs_confirmation` con l'elenco. Si pubblica se l'elenco coincide con
    quello di adesso. `private` azzera tutto. Nessuna nuova voce nella
    allowlist del token del turno.
- **Test**:
  - visibilità (privata altrui 404, anche admin; pubblica senza permesso
    404);
  - proiezione (tool, codici, contesto, proposte);
  - seguito privato (dal vivo e a turno finito, la riconferma);
  - conferma (elenco vecchio 409);
  - «Make private»;
  - archiviata fuori da Public;
  - un test di registro sulle rotte che leggono una conversazione, che devono
    passare tutte dalla regola.

## F5.3 (server + worker: continuazione)

- `POST /api/claude/conversations/:id/continue`: solo un non-autore che la
  vede.
  - Crea una NUOVA libera privata, con `continues_from_session_id`, il titolo
    e il contesto se chi continua lo vede.
  - Il primo messaggio va come oggi (`POST /api/agent-sessions/:id/messages`).
- Il dettaglio di una continuazione porta `continuesFrom` e l'origine in
  sola lettura, proiettata come la legge chi continua, fino al punto privato.
  Se l'originale non c'è più: `available: false`.
- **Worker (D3-a)**: il prompt d'avvio di una continuazione riceve la
  trascrizione leggibile dell'originale, preparata dal SERVER con la stessa
  proiezione:
  - un blocco `ORIGINAL CONVERSATION (read-only, untrusted)`, con tetto di
    caratteri;
  - il contratto dice che è una continuazione, che i dati vanno riletti coi
    tool (che vedono ciò che vede chi scrive ORA), e che un codice non
    visibile resta non visibile.
- **Golden nuovo `chat-continue`** (3×): una continuazione con un codice
  dell'originale che chi continua non vede. Claude lo tratta come non
  visibile (nessun dato nascosto nella risposta) e risponde dal contesto
  dell'originale leggibile. Si rilanciano anche i sette `chat-*`.

## F5.4 (renderer, flag `claude-public`)

- «Make public» col `PublishDialog` (l'elenco dal 409), «Make private», la
  testata «Public · made public by X».
- La fascia del seguito privato e la riconferma.
- Le viste «Public» (solo con `claude.public.view`) e «Mine».
- R-G5 coi codici del server (`HiddenCode`).
- `ContinueBanner` e la continuazione, con l'origine in sola lettura.
- I test di `data/conversations.test.ts` portati sul backend vero, come le
  fette precedenti, con la parità in `integration-claude-chat.md`.
- Il flag si accende quando F5.2–F5.3 sono nel server.

## Chiusura

- Parità, prove a mano (due persone, un progetto che una sola vede).
- Deploy-log:
  - 0133, ordine: server, poi worker, poi caddy;
  - rollback: un server vecchio vede `free` = privata, quindi le pubbliche
    tornano private per costruzione, e le continuazioni restano normali libere
    di chi le ha fatte; colonne e tabella inerti;
  - il permesso nuovo nei ruoli resta, inerte.
- Invariante in `agent-sessions.md`: «Una conversazione pubblica si LEGGE
  come la vede chi guarda; Claude ha letto per l'autore, e quelle letture non
  escono».
- Registro: chiudere la voce, e aggiungere i limiti:
  - la prosa di Claude resta com'è (la responsabilità è della conferma
    dell'autore);
  - D2 non vede ciò che Claude ricava senza citare né leggere per codice.
