---
title: App — architettura di navigazione
date: 2026-09-11
stubwise:
  project: stubwise
---

# App — architettura di navigazione

## 1. Perché esiste, e perché adesso

Stavo per decidere «dove metto Posta e Calendario» come domanda a sé. Il
maintainer l'ha fermata con quella giusta (11 set 2026):

> «La vera domanda arriverà con la M5, quando tutte le cose mancanti finiscono
> in App e quindi ci troviamo anche ticket, milestone, ecc. La vera domanda è
> quindi: quali sono tra tutte le pagine che metteremo quelle più importanti?
> Come funzionerà la navigazione dell'utente per raggiungere tutte le altre?»

Decidere una scheda per fase è il modo sicuro di arrivare a M5 con otto schede e
una barra che il sistema spezza in un menu «Altro» scelto da lui. Questo
documento colloca **tutto** ciò che arriverà fino a M5, una volta sola. Le fasi
successive non decidono più dove sta una sezione: la incastrano qui.

## 2. Il principio

**Il sito è organizzato per ENTITÀ** — ticket, backlog, progetti, posta,
calendario, ambienti, coda di rilascio. È giusto per uno schermo grande usato
seduti, dove si tiene aperta una scheda per ogni cosa.

**L'app va organizzata per INTENZIONE.** Un telefono si usa in piedi, per
trenta secondi: «cosa devo fare adesso», «prendo nota prima di dimenticarmene»,
«cerco una cosa».

E l'app lo fa già in un punto, senza che nessuno l'avesse dichiarato: il
dettaglio di un progetto raggruppa per **urgenza** — «aspetta qualcuno»,
«adesso», «pronto» (`apps/mobile/src/screens/projects/ProjectDetailScreen.tsx:171-189`)
— non per tipo di oggetto. Questo documento prende quella scelta implicita e la
rende la regola di tutta l'app.

## 3. Le cinque destinazioni

Oggi sono quattro (`apps/mobile/src/app/navigation.tsx:71-77`, sigle mono
INB/PRJ/BLG/DOC). Diventano cinque, e **restano cinque**.

| | Intenzione | Cosa contiene |
|---|---|---|
| **INB** — Inbox | *Cosa aspetta me* | Le notifiche azionabili. È il cuore, e lo è già. |
| **PRJ** — Progetti | *Come stanno le cose* | Il polso, e da lì **tutto ciò che riguarda un progetto** (§4). |
| **BLG** — Backlog | *Prendo nota* | Cattura rapida, raffinamento, conversione. |
| **DOC** — Docs | *Cerco una cosa* | Ricerca, pagine, «chiedi al progetto». |
| **(nuova)** | *La mia roba* | Posta e calendario: non sono di un progetto, sono **di una casella**. |

**Il limite di cinque non è estetico.** Su iPhone una barra nativa con più voci
ne nasconde alcune dietro un «Altro» **scelto dal sistema**: le sigle mono che
sono un tratto dell'identità di Stubwise finirebbero sepolte in un menu che non
controlliamo.

### Perché Posta e Calendario stanno insieme

Sono la stessa cosa vista da due lati: **ciò che arriva dalla tua casella
Google**. Condividono l'origine (`google_accounts`), la privacy (`user_id`
sempre nel WHERE, nessun ruolo scavalca — `apps/server/src/routes/me-mail.ts:66`)
e il fatto di non appartenere a un progetto. Separarle in due schede
spenderebbe due dei cinque posti per due metà della stessa idea.

## 4. Come si raggiunge tutto il resto: si SCENDE

Nessuna sezione nuova prende una scheda. Ogni cosa si aggancia a una delle
cinque, e la maggior parte si aggancia al **progetto**, perché è lì che ha
senso.

**Dentro un progetto** (da PRJ, o da una notifica): il lavoro e i suoi ticket,
la **roadmap con le milestone**, il **registro decisioni**, gli **ambienti**, il
brief settimanale, l'attività, le regole di smistamento della posta.

**Dentro una voce di backlog** (da BLG, o da una notifica): la chat di
raffinamento, le **domande a bottoni**, la conversione a ticket.

**Dentro un ticket**: il piano, la **pre-approvazione**, i job, il riassunto dei
fallimenti, la PR.

**Dalla notifica**: il deep link porta **direttamente all'oggetto**, saltando
ogni elenco — `stubwise://{inbox|tickets|projects}/:id`
(`apps/mobile/src/app/navigation.tsx:181-192`). È la strada più usata su un
telefono e va estesa alle sezioni nuove, non aggirata.

### Cosa NON esiste sull'app, ed è una scelta

- **Un elenco piatto di tutti i ticket dell'istanza.** Sul sito c'è (`/tickets`,
  `/board`); su un telefono non si scorre, e ogni ticket che ti riguarda
  davvero arriva da una notifica o da un progetto.
- **La coda di rilascio.** Già deciso nella fase 8: sei colonne di confronto non
  stanno su uno schermo, e l'unica azione che conta — rilasciare — richiede di
  averle guardate tutte e sei. Su un telefono sarebbe un bottone senza il suo
  contesto.
- **Le impostazioni d'istanza** (automazione, provider AI, plugin, storage,
  Slack, account git), i **repository**, il **monitoraggio**, l'**editing dei
  Docs**, i **widget**. Configurazione da schermo grande.

## 5. Le tre regole che tengono in piedi tutto questo

**(1) Nessuna sezione nuova prende una scheda.** Se un giorno qualcosa non si
aggancia a nessuna delle cinque, è il segnale che **le cinque sono sbagliate** —
non che ne serve una sesta. In quel caso si riapre questo documento, non si
aggiunge una voce.

**(2) Da una notifica si arriva all'oggetto, mai a un elenco.** Ogni sezione
nuova che può generare notifiche estende `resolveDeepLinkTarget` nello stesso
lavoro che la introduce, non «dopo».

**(3) Il «indietro» torna da dove sei venuto, non alla radice della scheda.**
Arrivando a un ticket da una notifica, indietro torna all'inbox; arrivandoci da
un progetto, torna al progetto. È il comportamento che gli stack di
`@react-navigation` danno gratis e che si perde solo forzandolo.

## 6. Cosa questo documento NON decide

- **La sigla e l'icona della quinta scheda.** Vanno scelte come le altre
  quattro: tre lettere mono, e due icone **verificate per piattaforma** — il
  docblock a `navigation.tsx:133-149` documenta che quelle attuali sono state
  controllate contro `sf-symbols-typescript` e le Material Design Icons, ed è la
  disciplina da ripetere.
- **La forma del calendario su un telefono.** Sul sito è una griglia
  giorno/settimana/mese; su uno schermo stretto probabilmente è un'agenda per
  giorni. ⚠️ La logica della griglia (`apps/web/src/lib/calendar-grid.ts`) è
  **TypeScript puro senza DOM**: è condivisibile come `workStateFor` e
  `deriveNextStep`, qualunque forma si scelga. L'app oggi non ha **nessuna**
  vista temporale e nessuna formattazione di data oltre a
  `relativeTimeCompact` (`apps/mobile/src/lib/format.ts:16-20`).
- **Quali schermate di un progetto sono a loro volta schede interne** (il
  dettaglio progetto oggi è una schermata sola che scorre).

## 7. Il confine tecnico da conoscere

**Nessuna rotta server nuova serve** per niente di quanto sopra: il server
espone già tutto. Il confine è nel **client condiviso**:
`packages/api-client/src/endpoints/` ha `activity, auth, backlog, docs, inbox,
me, pats, projects, search, tickets` — **non ha `mail.ts` né `calendar.ts`**, e
non ha i metodi per le domande di backlog né per la pre-approvazione del piano.
Il web per quelle sezioni usa un client proprio (`apps/web/src/lib/api.ts`).

Ogni fase che porta una sezione sull'app porta con sé il suo pezzo di
`@stubwise/api-client`. È lavoro che serve comunque, e che rende quella sezione
disponibile a entrambe le app.

⚠️ Una assunzione scritta nel codice che il mobile invaliderà:
`calendarSeriesPatchSchema` (`packages/shared/src/schemas/google.ts:723-726`)
dice testualmente «qui non c'è un client mobile che scrive questo corpo». Chi
porta la configurazione delle serie sull'app corregga quel commento nello stesso
commit.
