---
title: Fase 6b — Un'email, più progetti (fan-out delle proposte)
date: 2026-09-08
status: validato (brainstorming)
program: 2026-08-31-stubwise-nerve-center-program-design.md
extends: 2026-09-07-phase6-google-mail-calendar-design.md
stubwise:
  project: stubwise
  backlog: 7053e669-10f0-4f61-8895-929e560024f4
  ticket: https://stubwise.thecove.it/tickets/6c50ef02-486f-465b-ad80-766557783d76
---

# Fase 6b — Un'email, più progetti

Estensione della fase 6, decisa il giorno stesso del deploy. La fase 6
assume che **un'email riguardi un progetto**. È un'assunzione sbagliata: il
caso più frequente in un'istanza con dodici progetti è il **recap di una
riunione interna**, dove un solo messaggio contiene avanzamenti e cose da
fare per più progetti. Oggi quel messaggio produce al massimo una proposta,
su un progetto solo, e tutto il resto va perso in silenzio.

Questa fase rende il modello **un'email → N proposte, una per progetto**,
ciascuna con le sue opzioni e il suo ciclo di conferma indipendente.

## 1. Stato di partenza (fatti verificati sul codice)

Il limite è strutturale e sta in **dodici punti** (verificati in
`email_messages`, `classify.ts`, `proposal.ts`, `google-proposal.ts`,
`me-mail.ts`). I quattro che contano:

- **Routing collassa a un progetto**: `matchRoutes`
  (`packages/notifications/src/email-routing.ts:277-289`) sceglie **un**
  vincitore per numero di regole soddisfatte; `candidateProjectIds` è
  popolato **solo in caso di parità**, quindi «N progetti citati» oggi non è
  nemmeno rappresentabile.
- **Insieme ammesso di cardinalità 1**: `apps/worker/src/google/classify.ts:385`
  `const allowed = message.projectId ? [message.projectId] :
  message.candidateProjectIds`. Anche se il modello nominasse un secondo
  progetto, `revalidateProposal:509` lo scarta. Il contesto (ticket aperti,
  titoli di backlog) è caricato **solo** per il progetto risolto
  (`:405-459`), e la mappa dei ticket è chiavata sul solo `number`: `#3` di
  due progetti collide.
- **Claim scalare in pubblicazione**: `publishProposal`
  (`apps/worker/src/google/proposal.ts:566-574`) claima
  `status='classified' AND proposal_notification_id IS NULL` **sulla riga
  del messaggio**: la seconda proposta sullo stesso messaggio è
  `not_claimable`. Idem la selezione del poller (`poller.ts:1053-1074`).
- **Chiusura totale**: `markSourceOutcome`/`markSourceFailed`
  (`google-proposal.ts:271-309`) scrivono `status`, `outcome`, `error` del
  **messaggio**: la prima conferma chiude anche le eventuali sorelle.
  `choose_project` (`:449-478`) fa `status='new'` e azzera la notifica,
  cioè distruggerebbe le sorelle già proposte.

Colonne scalari sul padre che vanno ripensate: `project_id`,
`proposal_notification_id`, `outcome`, `error`, e in parte `status`.
Precedenti nel repo per una relazione uno a molti con stato per riga:
`notification_deliveries` (stato proprio, claim con indice parziale) e
`ticket_repositories` (unique sulla coppia, stato del padre derivato
dall'aggregato dei figli).

## 2. Perimetro (deciso)

Dentro: tabella figlia `email_proposals` con stato e claim per riga;
perimetro completo dei progetti al posto del solo vincitore; contesto e cap
per progetto nella classificazione; una card per progetto con il nome del
progetto nella domanda; esecuzione, retention e pagina Posta adeguate.

Fuori: il **calendario resta uno a uno** (un evento riguarda un progetto: il
fan-out non serve e complicherebbe senza motivo); nessun cambiamento al
routing come lo configura l'utente (le regole restano quelle); nessuna
modifica all'app mobile (la card resta informativa, come in fase 6).

## 3. Schema

**Tabella figlia** `email_proposals` (migrazione 0070, nessun valore di enum
nuovo quindi tutto in un batch):

```
email_proposals(
  id uuid PK,
  email_message_id uuid NOT NULL FK → email_messages.id ON DELETE cascade,
  project_id uuid NOT NULL FK → projects.id ON DELETE cascade,
  status text NOT NULL DEFAULT 'classified'
    CHECK in ('classified','proposed','actioned','ignored','failed'),
  classification jsonb NOT NULL,        -- {summary, proposals[], recommendedIndex} DI QUESTO progetto
  proposal_notification_id uuid FK → notifications.id ON DELETE set null,
  outcome jsonb, error text,
  created_at, updated_at,
  UNIQUE (email_message_id, project_id)
)
INDEX email_proposals_claim_idx (email_message_id)
  WHERE status = 'classified' AND proposal_notification_id IS NULL
```

**Sul padre** `email_messages`:
- `scope_project_ids uuid[]` NOT NULL default `{}`: **tutti** i progetti con
  almeno una regola soddisfatta (il perimetro), non solo la parità.
  `candidate_project_ids` resta per compatibilità ma smette di essere l'unica
  fonte; `project_id` resta come «progetto principale» (il vincitore) per
  l'indice `(project_id, received_at)` e per i filtri della pagina.
- `status` cambia significato: resta il workflow di **ingest e
  classificazione** (`new` → `classified` | `ignored` | `failed`) e diventa
  **derivato** per lo stato finale: `actioned` **solo quando tutti** i figli
  sono terminali (gate aggregato, come `ticket_repositories`).
- `proposal_notification_id`, `outcome`, `error` restano sul padre **solo per
  il calendario** e per le righe storiche; per la posta l'ancora si sposta
  sul figlio.
- **Backfill** nella migrazione: per ogni `email_messages` in
  `classified`/`proposed` con `project_id` non nullo, una riga figlia che
  eredita `classification`, `status` e `proposal_notification_id`. In prod
  oggi non ce n'è nessuna (zero messaggi ingeriti), ma la migrazione deve
  essere corretta comunque.

## 4. Routing e classificazione

- `matchRoutes` restituisce anche `scopeProjectIds`: tutti i progetti con
  `matchedRuleCount > 0` (il conteggio esiste già,
  `email-routing.ts:92,256-271`). Il vincitore continua a esistere e resta il
  «progetto principale»: cambia solo che non è più l'unico ammesso.
- `classify.ts:385`: `allowed` = `scopeProjectIds` (fallback ai candidati e
  al progetto risolto per le righe vecchie).
- **Contesto per progetto** (`loadContext:381-469`): ticket aperti e titoli
  di backlog caricati per **ciascun** progetto del perimetro, con la mappa
  dei ticket chiavata `(projectId, number)` per evitare la collisione dei
  numeri. Il prompt elenca i progetti con nome e descrizione, e per ciascuno
  il suo contesto, sotto intestazioni separate.
- **Cap**: `CLASSIFY_MAX_PROPOSALS` (oggi 3, globale) diventa **per
  progetto**; nuovo `GMAIL_MAX_PROJECTS_PER_MESSAGE` (default **5**) limita
  il fan-out, così una mail in copia a dieci progetti non genera dieci card;
  il contesto per progetto è ridotto (10 titoli invece di 20) perché ora
  cresce in modo lineare col numero di progetti.
- **Nessun cambio al protocollo di output del modello**: ogni proposta porta
  già un `projectId` proprio (`emailProposalSchema:127`) e la rivalidazione
  lo confronta con un insieme. La partizione per progetto si fa **nel
  codice**, dopo `revalidateClassification`, non chiedendo al modello di
  raggruppare: stessa garanzia, meno superficie.
- **Scrittura**: al posto dell'UPDATE su `email_messages`, un upsert per
  progetto su `email_proposals` con `ON CONFLICT (email_message_id,
  project_id)`, **guardato su `status = 'classified'`**: una riclassificazione
  non tocca mai un figlio già `proposed`, `actioned`, `ignored` o `failed`. I
  figli `classified` non più pertinenti vengono eliminati; mai un `DELETE`
  totale, che cancellerebbe una card aperta lasciando la notifica orfana.
- `signal` resta sul padre (è una proprietà del messaggio).

## 5. Proposte ed esecuzione

- `buildEmailProposalEvent` riceve **la riga figlia**: il progetto è certo.
  L'evento guadagna `projectId` accanto a `projectName`, e la domanda passa
  da un template i18n che **nomina il progetto**: con N card sullo stesso
  messaggio, mittente e oggetto sono identici e senza il nome del progetto le
  card sarebbero indistinguibili in inbox e su Slack.
- **`choose_project` viene rimossa dalla generazione.** Il fan-out risponde
  già alla domanda «di quale progetto è questa mail»: se il perimetro ne
  contiene più d'uno, nascono più proposte. L'azione resta nell'unione e
  nell'esecutore **solo** per le card già pubblicate prima di questa fase
  (retro-compatibilità), con un commento che ne dichiara la deprecazione.
- `publishProposal` claima **la riga figlia**
  (`WHERE id = $child AND status='classified' AND proposal_notification_id IS
  NULL`) mantenendo l'ordine attuale: publish, ritrovamento dell'id, UPDATE
  guardato come **ultima** scrittura della transazione. Lo stato aggregato
  del padre si **calcola in lettura**, non si persiste: due proposte dello
  stesso messaggio possono così essere pubblicate in parallelo senza
  contendersi la riga padre.
- Selezione nel poller: join tra figli `classified` senza notifica e padre,
  filtrata per casella. Il tetto per tick ora conta **proposte**, non
  messaggi.
- `findSourceRow` cerca prima in `email_proposals` per
  `proposal_notification_id` (lookup esatta), poi in `calendar_events`.
  `ProposalSource` porta anche `emailMessageId` e `projectId`.
- `markSourceOutcome`/`markSourceFailed` scrivono **sul figlio**; nella
  stessa transazione il padre viene toccato solo per aggiornare
  `updated_at` (serve alla retention, vedi sotto).
- `record_decision` mantiene `sourceKey = email:<gmailMessageId>`: l'unique
  del registro è `(project_id, source_key)` e il fan-out è per progetto,
  quindi due proposte su progetti diversi non collidono. È l'unique
  `(email_message_id, project_id)` sul figlio a rendere sicura questa chiave.
- `propagateHandled` è già per `proposalId`, quindi chiude solo le copie di
  quella card: le sorelle restano aperte. È il comportamento voluto.

## 6. Retention e pagina Posta

- **Retention**: un messaggio è potabile solo quando **tutti** i figli sono
  terminali e nessuna notifica collegata è aperta. La soglia si misura su
  `updated_at` del padre, che va aggiornato a ogni chiusura di figlio,
  altrimenti misura la cosa sbagliata. Senza questa condizione la potatura
  cancellerebbe un messaggio con una card ancora aperta, e la cascata la
  renderebbe inconfermabile.
- **Pagina Posta**: una riga per **proposta**, non per messaggio. Mittente e
  oggetto si ripetono, con il badge del progetto a distinguerle: è la forma
  che risponde alla domanda vera («cosa è stato fatto per il progetto X?»).
  `MailItem.id` diventa l'id del figlio per le righe di posta; il calendario
  resta com'è. «Riproponi» agisce sul figlio (`failed`/`ignored`), non sul
  messaggio. I contatori del riepilogo contano i figli. È una rottura di
  contratto accettabile: la funzione è stata deployata oggi e nessuno ci ha
  ancora costruito sopra.

## 7. Test e deploy

- **Test**: routing con perimetro multiplo (tre progetti, uno vincitore);
  classificazione che partiziona per progetto con contesto e cap per
  progetto, collisione `#3` fra progetti risolta, tetto sul fan-out;
  riclassificazione che non tocca i figli non `classified` e rimuove solo i
  `classified` obsoleti; pubblicazione di due proposte dallo stesso
  messaggio (entrambe pubblicate, notifiche distinte, nomi di progetto
  diversi nella domanda); conferma di una che **non** chiude le sorelle;
  fallimento di una che lascia le altre; retention che non pota con un figlio
  aperto; `choose_project` su una card storica ancora eseguibile; pagina
  Posta con più righe per messaggio e «Riproponi» sul figlio; migrazione con
  backfill.
- **Deploy**: migrazione 0070 (una tabella, una colonna sul padre, backfill;
  nessun enum, quindi un solo batch); rebuild server, worker e caddy insieme;
  nessuna env nuova. **Rollback**: `GMAIL_POLL_MINUTES=0` resta la strada
  innocua; scendere di immagine sul server è sicuro (nessun kind nuovo,
  nessun valore aggiunto a un enum esistente), ma le proposte già pubblicate
  puntano a righe figlie che il binario vecchio non conosce e
  risponderebbero `proposal_stale`: vanno chiuse a mano o si accetta di
  perderle.
