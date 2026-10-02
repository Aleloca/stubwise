---
stubwise:
  project: stubwise
  backlogItem: 756cf96c-0b02-48a1-8a8f-0a32aa79a880 # https://stubwise.thecove.it/backlog/756cf96c-0b02-48a1-8a8f-0a32aa79a880
---

# App: la pagina del ticket a tab

Data: 2 ott 2026. Stato: design approvato, corretto dopo la verifica delle
premesse del piano (`2026-10-02-app-ticket-tabs.md` §1) e le decisioni del
maintainer del 2 ott. Solo app mobile: il web non cambia.

## 1. Il problema, verificato sul codice di oggi

`WorkScreen` (`apps/mobile/src/screens/work/WorkScreen.tsx`) mette tutto in una
colonna sola, in quest'ordine: intestazione (stato, numero, titolo) →
descrizione in markdown → indicatore «AI al lavoro» → domanda dell'AI → piano
→ bottone di run → Pull requests (`PrCycleSection`) → campi → timeline →
commenti → nota sul rilascio → livello tecnico (admin) → azioni distruttive.

La descrizione, sui ticket nati da un design, è un documento intero: in cima
alla pagina spinge tutto il resto (le PR, i commenti, cosa fare) molto in
basso. Il piano invece in pagina è già compatto (`PlanSection`: riassunto o le
prime 4 righe, più «Leggi il piano completo» che apre il testo intero in una
modale) e contiene AZIONI (approva, rifiuta, pre-approva, revoca). Il titolo
sta in `ScreenHeader`, non nel corpo; il nome del branch non è nella sezione
delle PR (sta solo nel livello tecnico, per gli admin). Lo scroll è lunghissimo. Feedback del maintainer dopo la prova dal
vivo del ciclo di correzione (2 ott 2026), che ha trovato poco leggibile anche
la sezione delle PR.

## 2. Struttura

**Intestazione fissa** (non scorre): badge di stato, numero, titolo e — quando
un job gira — l'indicatore «AI al lavoro».

**Barra delle tab fissa** subito sotto. Quattro tab:

| Tab | Contenuto, nell'ordine |
|---|---|
| **Stato** | domanda dell'AI (se c'è) → piano compatto con le sue azioni (`PlanSection`) → bottone di run → card delle PR → nota sul rilascio |
| **Contenuto** | descrizione (markdown) → piano intero (markdown) |
| **Attività** | commenti (con il campo per scriverne uno) → timeline |
| **Dettagli** | campi (assegnatario, priorità, milestone…) → livello tecnico (solo admin) → azioni distruttive |

- In Attività i commenti stanno sopra la timeline: sono ciò che si legge e a
  cui si risponde; la timeline è storia.
- Stato risponde solo a «a che punto è e cosa devo fare»: niente campi. Per
  questo il piano compatto con Approva/Rifiuta resta in Stato (il pallino
  «piano da approvare» deve indicare la tab dove l'azione c'è), mentre il
  testo intero va in Contenuto: «Leggi il piano completo» porta alla tab
  Contenuto invece di aprire la modale.
- Ogni tab scorre per conto suo e ricorda la sua posizione quando si cambia
  tab e si torna.

## 3. Quale tab si apre

- Da lista, ricerca, hub del progetto: **Stato**.
- Da una notifica: la tab che c'entra. Le push aprono la card in inbox (oggi
  vero), ma oggi il tasto «Apri» della card apre il BROWSER (`openURL` di
  `item.url`: la pagina web del ticket, o la PR per le card PR). Con questo
  lavoro «Apri» apre il ticket NELL'APP (`navigate("Ticket", { id: ticketId,
  tab })`) quando la card ha un `ticketId`; una card senza `ticketId` resta
  com'è oggi (`openURL`). Vale anche per le card PR (`job.pr_opened`,
  `review.completed`), che aprono la tab Stato: la PR si apre dal titolo della
  sua card nella pagina del ticket. `PlanReviewCard`, che oggi non ha «Apri»,
  lo guadagna quando ha un ticket. Le card che non riguardano un ticket
  (posta, pulse, monitor, brief…) restano invariate.
- La rotta guadagna un parametro FACOLTATIVO `tab` (`"status" | "content" |
  "activity" | "details"`), deciso dal tipo di notifica. Oggi TUTTI i kind di
  ticket vanno su Stato: `job.awaiting_input`, `job.plan_review`,
  `review.completed`, `job.pr_opened`, `job.failed`, e anche `job.pr_closed`,
  `job.held`, `job.budget_held`, `ticket.created`. Nessuna notifica porta ad
  Attività (non esiste un kind per i commenti): il valore `activity` resta per
  il deep link. Senza parametro, o con un valore sconosciuto, si apre Stato.

## 4. Indicatori sulle tab

- **Stato**: un pallino quando serve un'azione di chi guarda, in uno di questi
  casi (solo dati che lo schermo ha già, nessun campo nuovo dal server):
  - c'è una domanda dell'AI e `canAnswer`;
  - c'è un piano da approvare e `canDecide`;
  - una PR aspetta una persona E l'azione è davvero offerta (pallino solo
    dove c'è un bottone premibile): PR aperta con «Chiedi modifiche» offerto
    (`canRequestCorrection`) e `cycle.state` in `stopped_at_cap`,
    `correction_failed` o `changes_requested` (che copre sia il ciclo
    automatico spento sia l'attesa di una richiesta umana); oppure una
    correzione ferma con «Riprendi» offerto (`canResume` + `heldJobId`) e
    `heldReason` `budget` o `other` — **non** `limit`, che riparte da sola.
  - `canAnswer` e `canDecide` non arrivano dal server: si usa la deduzione
    dal ruolo che la schermata fa già oggi (l'autorità resta il server).
- **Attività**: il numero dei commenti, come contatore compatto neutro
  accanto all'etichetta (quattro etichette maiuscole più « · 4» non stanno in
  375 pt), senza pallino; assente se i commenti non si sono caricati.
- Contenuto e Dettagli: niente.

## 5. La card della PR (tab Stato)

Una card per PR (esempio vero, ticket #1 di Stubwise Test):

```
┌─ stubwise-test · PR #4 ↗ ───────────┐
│  ● APPROVATA DALLA REVIEW           │
│  pronta per il merge                │
│  Modifiche richieste da Alessandro  │
│  Locatelli su Bitbucket · 2 h fa    │
│  [        Chiedi modifiche        ] │
└─────────────────────────────────────┘
```

1. **Titolo**: repository · «PR #N», tutto toccabile, apre la PR sulla
   piattaforma (sostituisce il link «Open the PR →»). Con la PR mergiata o
   chiusa, un'etichetta accanto.
2. **Chip di stato**, maiuscolo e colorato coi toni di OGGI (`TONE_BY_STATE`,
   gemelli del web): `approved` verde (`ok`); `reviewing`/`correcting`
   azzurro (`sky`); `changes_requested`, `stopped_at_cap` e una correzione
   ferma per budget o altro ambra (`signal`); ferma per limite azzurro;
   `correction_failed` rosso (`danger`); `idle` grigio. È la prima cosa che si
   legge.
3. **Dettaglio** in grigio, solo se aggiunge qualcosa: «pronta per il merge»,
   «giro 2 di 3», «budget esaurito · chiedi a un maintainer», «parte quando
   finisce il lavoro in corso sul ticket».
4. **Chi ha chiesto l'ultima volta**, in grigio, col testo che esiste già,
   gemello del web («Modifiche richieste da {{name}} su Bitbucket»), più il
   tempo relativo calcolato sul telefono da `lastRequest.at` con
   `relativeTimeCompact` (`lib/format.ts`; il criterio è quello di
   `stalled.ts`: il server manda la data, mai un conteggio). Con una richiesta
   in coda si accoda «in coda · parte quando finisce il lavoro in corso sul
   ticket».
5. **Bottone a tutta larghezza**: «Chiedi modifiche» / «Riprendi la
   correzione», solo con `canRequestCorrection` / `canResume` + `heldJobId`
   come oggi; altrimenti assente.

Sparisce l'eyebrow «Pull requests» (la tab lo dice già). Il nome del branch
oggi non è nella sezione: resta dov'è, nel livello tecnico (Dettagli, admin).

**Conseguenza tecnica**: oggi la riga di stato è una frase sola, gemella del
web (`prCycleLineFor`) e presidiata da un test di parità dei testi. Spezzarla
in chip + dettaglio + richiesta vale solo per l'app: il web resta com'è. Si
riusano chiavi e testi dove possibile; il test di parità va adattato perché
confronti i pezzi, non la frase intera. La regola del rilancio generico
(`isHeldCorrectionJob`) non cambia.

## 6. Errori e casi limite

- Il ticket non si carica: l'errore di oggi, sopra le tab.
- Letture accessorie (commenti, utenti, milestone) fuori dai gate di
  caricamento come oggi: se falliscono, degrada solo la loro tab.
- Offline: le tab sono navigazione locale, funzionano.

## 7. Test

Con le tre trappole dell'app di CLAUDE.md (fixture complete, metodi nel
doppio `makeClient()` prima del test, `await render`):

- pallino su Stato nei quattro casi, e assente senza niente da fare;
- parametro `tab`: ciascun valore, assente, sconosciuto;
- card della PR in ogni stato del ciclo, più una fixture con SOLO i campi
  nuovi del ciclo e una da server vecchio (`cycle: null`);
- posizione di scorrimento conservata cambiando tab;
- test di parità dei testi adattato ai pezzi della riga;
- la regola del rilancio generico resta coperta dai test esistenti.

## 8. Deploy

Solo l'app (build sul telefono / store). Nessuna rotta, nessuno schema, server
e web invariati.

## 9. Fuori da questo lavoro

- La pagina del ticket sul web.
- Nuovi campi dal server per gli indicatori.
