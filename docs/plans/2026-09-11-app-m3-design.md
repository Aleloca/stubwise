---
title: App M3 — il divario che conta
date: 2026-09-11
stubwise:
  project: stubwise
---

# App M3 — il divario che conta

Parte del **Programma App — Stubwise Go**
(`docs/plans/2026-09-11-mobile-app-program-design.md`), dentro l'architettura di
`docs/plans/2026-09-11-app-navigation-architecture-design.md`.

## 1. Perimetro

Quattro cose, che il maintainer ha scelto di fare **insieme** (11 set 2026) pur
avendo io proposto di dividerle:

1. Le **domande a bottoni** nella chat del backlog (fase 7).
2. La **pre-approvazione del piano** (fase 7).
3. La **Posta** (fasi 6/6b/6c, 9).
4. Il **Calendario** con le serie ricorrenti (fasi 7b, 9).

Le prime due **completano** ciò che l'app ha già: schermate esistenti, componenti
esistenti, rotte esistenti. Le seconde due sono **due sezioni nuove**. Sono
lavori di natura diversa, quindi il piano li tiene in **quattro fasi separate,
con un report fra l'una e l'altra**: una review sola su tutto non si fa bene.

**M3 non costruisce le schede interne al progetto.** Quella decisione
(architettura §6c) serve a roadmap, decisioni e ambienti, che arrivano dopo. Qui
il dettaglio progetto non si tocca.

## 2. Il confine, verificato

**Nessuna rotta server nuova serve.** Il server espone già tutto:
- la domanda aperta viaggia dentro `GET /api/backlog/:id`
  (`backlogItemDetailSchema.openQuestion`, `packages/shared/src/schemas/backlog.ts:354`);
- i tre campi della pre-approvazione dentro `GET /api/tickets/:id`
  (`planApprovedAt`, `planApprovedBy`, `planApprovalStale`, tutti già
  `.optional()` per l'app installata, `packages/shared/src/schemas/ticket.ts:141-150`);
- posta e calendario hanno dieci endpoint completi
  (`apps/server/src/routes/me-mail.ts`, `me-calendar.ts`).

**Il confine è nel client condiviso.** `packages/api-client/src/endpoints/` ha
`activity, auth, backlog, docs, inbox, me, pats, projects, search, tickets` —
**non ha `mail.ts` né `calendar.ts`**, e `backlog.ts`/`tickets.ts` non hanno i
metodi per le domande né per la pre-approvazione. Il web per quelle sezioni usa
un client proprio (`apps/web/src/lib/api.ts`).

Ogni fase porta con sé il suo pezzo di `@stubwise/api-client`. È lavoro che
serve comunque e che rende quella superficie disponibile a entrambe le app.

**⚠️ Nessuna dipendenza nativa nuova in M3**, ed è una scelta esplicita dopo
l'incidente dell'11 settembre (`react-native-bottom-tabs` non compilava con
`use_frameworks!`, che serve a Firebase). Se qualcosa sembra richiederne una,
**ci si ferma e si chiede**.

## 3. Le domande a bottoni

L'app ha già **quasi tutto il comportamento difficile**.
`apps/mobile/src/components/inbox/QuestionSheet.tsx` porta le stesse invarianti
del pannello web: il bail-out totale sugli indici (una sola etichetta vuota
azzera l'elenco, mai compattare), la consigliata **mai** preselezionata, il
controllo di range su `recommendedIndex`, il reset sul cambio di domanda.

Le distanze sono tre, e circoscritte: è un **foglio modale** invece di un blocco
in linea nella chat; non ha **«non ora»**; non degrada a nulla quando non c'è
niente di azionabile (renderebbe un foglio vuoto).

### ⚠️ Il nodo di perimetro

Le domande nascono **solo in modalità CODE** — la sessione di analisi sul
codice. E `BacklogChatScreen.tsx` ha una guardia **dichiarata nel file**
(`:31-35`, `:43-52`): con una sessione attiva il composer si disabilita con un
avviso, perché «gestire per intero la modalità CODE resta FUORI SCOPE».

Portare le domande significa **aprire quella modalità sull'app**, che finora era
stata deliberatamente lasciata fuori. Non è un dettaglio da risolvere in corsa:
va deciso cosa l'app fa di una sessione di analisi — se la mostra soltanto (le
domande arrivano e si risponde, i turni li fa il worker) o se la si può anche
avviare e fermare.

**La posizione del design**: l'app **risponde** alle domande di una sessione già
avviata, e **non** la avvia né la ferma. Avviare un'analisi è una decisione di
spesa che si prende davanti al codice; rispondere a una domanda è ciò che si fa
in fila alle poste — ed è il motivo per cui questa funzionalità esiste.

### Un difetto preesistente da chiudere, anche sul web

`answerErrorMessage` (`apps/web/src/components/question-panel.tsx:53-73`) mappa
`already_handled`, ma per una domanda già risposta il server manda
**`already_answered`** (`apps/server/src/routes/backlog.ts`). Quindi quando due
persone rispondono insieme, la seconda vede un messaggio generico invece di
«ha già risposto qualcun altro». Vale su web e su mobile
(`describeInboxError`, `apps/mobile/src/lib/inbox-mutations.ts:65-94`).

## 4. La pre-approvazione del piano

L'app distingue già maintainer da operatore (`WorkScreen.tsx:135`) e ha già
approva/rifiuta (`PlanSection`, `lib/work-mutations.ts:88-98`). Mancano il
**bottone** di pre-approvazione per il maintainer e la **riga di stato** per
tutti — inclusa quella che dice che l'approvazione è **decaduta** perché il
piano è cambiato (`planApprovalStale`).

Sul web la riga di stato è visibile **anche all'operatore**
(`apps/web/src/routes/tickets/$id.tsx:555-620`), ed è giusto: sapere che il
piano è già approvato è ciò che dice all'operatore che può partire.

**Il divieto resta dov'è**: pre-approvare è `requireAdmin` sul server, con il
controllo ripetuto nel servizio. L'app non lo indebolisce — mostra il bottone
solo al maintainer, ma la difesa vera è lato server e lì resta.

## 5. La Posta

**Decisione del maintainer: testo, niente WebView.** Sul web il corpo è HTML
sanificato dentro un `<iframe sandbox>`; in React Native l'iframe non esiste e
l'equivalente sarebbe una **WebView**, cioè una dipendenza nativa nuova — la
classe di rischio che ci è costata l'11 settembre.

Il testo esiste già, in due forme distinte che **vanno tenute distinte anche
nella copy**:
- `textExcerpt` (`apps/server/src/routes/me-mail.ts:826-841`) — dal database,
  nessuna chiamata a Google, è un **estratto**: niente citazioni, firma,
  allegati. `null` sui messaggi anteriori alla fase 6.
- `bodyText` (`:895-897`) — riletto da Gmail su richiesta, è il corpo pieno
  convertito in testo.

Entrambi sono **testo semplice, non markdown**: non vanno passati a
`react-native-markdown-display`, che l'app usa per contenuti markdown veri.

**La lista sarà sempre corta** — 33 messaggi su quattro caselle in produzione —
perché entra solo la posta ammessa. Si disegna per venti righe, non per duemila.

**ACL**: `user_id` sempre nel WHERE, nessun ruolo scavalca, nemmeno un admin
(`me-mail.ts:66`). L'app non deve introdurre nessuna scorciatoia.

## 6. Il Calendario

**Griglia mensile con i puntini, e il giorno scelto sotto**
(architettura §6b). Riusa `monthGridDays` da `apps/web/src/lib/calendar-grid.ts`,
che è TypeScript puro senza DOM: va **spostato in `packages/shared`** e usato da
entrambe le app, come `workStateFor` e `deriveNextStep` prima di lui.

**⚠️ La navigazione fra i mesi si ferma ai bordi della finestra di ingestione**
(`now − 30 giorni → now + 60`). Oltre, i mesi sarebbero vuoti non perché non ci
fossero impegni ma perché lì Stubwise non guarda — e sembrerebbe un guasto. Al
bordo la pagina dice perché.

**Lo stato vuoto è il caso normale, non l'eccezione.** Il calendario è sparso per
costruzione: mostra il **lavoro riconosciuto**, non la settimana. Un giorno vuoto
non dice «nessun evento»: dice che qui si vedono solo gli appuntamenti che
combaciano con le regole dei progetti, e indica dove si cambiano.

**Le serie ricorrenti si configurano dal dettaglio dell'evento**, come sul web:
accesa/spenta (default spenta), progetto, azione, anticipo, automatica.

⚠️ Il commento di `calendarSeriesPatchSchema`
(`packages/shared/src/schemas/google.ts:723-726`) dice testualmente «qui non c'è
un client mobile che scrive questo corpo». **Questa fase lo invalida**: va
corretto nello stesso commit che porta la scrittura sull'app.

## 7. La navigazione

La quinta scheda **`MBX` — Mailbox** (architettura §6a) contiene posta e
calendario, con uno scambio in alto. Icona: busta su iOS, equivalente Material
su Android, **verificate per piattaforma** come le altre quattro.

**I deep link si estendono nella stessa fase che introduce la sezione**
(architettura, regola 2): oggi `resolveDeepLinkTarget`
(`apps/mobile/src/app/navigation.tsx:181-192`) copre `inbox`, `projects`,
`tickets`. Una proposta di posta o di calendario che arriva come notifica deve
portare **all'oggetto**, non alla lista.

## 8. Cosa NON entra

- **Le schede interne al progetto** e ciò che ci andrà dentro (roadmap,
  decisioni, ambienti): sono di una fase successiva.
- **Avviare o fermare una sessione di analisi** dall'app (§3).
- **La WebView** e quindi l'HTML delle email (§5).
- **La coda di rilascio**, l'elenco piatto dei ticket, le impostazioni
  d'istanza: fuori dall'app per scelta (architettura §4).
- **Qualunque dipendenza nativa nuova** (§2).
