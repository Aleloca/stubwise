---
stubwise:
  project: stubwise
  backlogItem: 756cf96c-0b02-48a1-8a8f-0a32aa79a880 # https://stubwise.thecove.it/backlog/756cf96c-0b02-48a1-8a8f-0a32aa79a880
---

# App: la pagina del ticket a tab

Data: 2 ott 2026. Stato: design approvato, piano da scrivere. Solo app mobile:
il web non cambia.

## 1. Il problema, verificato sul codice di oggi

`WorkScreen` (`apps/mobile/src/screens/work/WorkScreen.tsx`) mette tutto in una
colonna sola, in quest'ordine: intestazione (stato, numero, titolo) →
descrizione in markdown → indicatore «AI al lavoro» → domanda dell'AI → piano
→ bottone di run → Pull requests (`PrCycleSection`) → campi → timeline →
commenti → nota sul rilascio → livello tecnico (admin) → azioni distruttive.

Descrizione e piano, sui ticket nati da un design, sono documenti interi: in
cima alla pagina spingono tutto il resto (le PR, i commenti, cosa fare) molto
in basso. Lo scroll è lunghissimo. Feedback del maintainer dopo la prova dal
vivo del ciclo di correzione (2 ott 2026), che ha trovato poco leggibile anche
la sezione delle PR.

## 2. Struttura

**Intestazione fissa** (non scorre): badge di stato, numero, titolo e — quando
un job gira — l'indicatore «AI al lavoro».

**Barra delle tab fissa** subito sotto. Quattro tab:

| Tab | Contenuto, nell'ordine |
|---|---|
| **Stato** | domanda dell'AI (se c'è) → bottone di run → card delle PR → nota sul rilascio |
| **Contenuto** | descrizione (markdown) → piano |
| **Attività** | commenti (con il campo per scriverne uno) → timeline |
| **Dettagli** | campi (assegnatario, priorità, milestone…) → livello tecnico (solo admin) → azioni distruttive |

- In Attività i commenti stanno sopra la timeline: sono ciò che si legge e a
  cui si risponde; la timeline è storia.
- Stato risponde solo a «a che punto è e cosa devo fare»: niente campi.
- Ogni tab scorre per conto suo e ricorda la sua posizione quando si cambia
  tab e si torna.

## 3. Quale tab si apre

- Da lista, ricerca, hub del progetto: **Stato**.
- Da una notifica: la tab che c'entra. Le push aprono la card in inbox, e il
  tasto «apri il ticket» della card naviga a `Ticket`. La rotta guadagna un
  parametro FACOLTATIVO `tab` (`"status" | "content" | "activity" |
  "details"`), deciso dal tipo di notifica: `job.awaiting_input`,
  `job.plan_review`, `review.completed`, `job.pr_opened`, `job.failed` →
  Stato; le notifiche di commento → Attività. Senza parametro, o con un valore
  sconosciuto, si apre Stato.

## 4. Indicatori sulle tab

- **Stato**: un pallino quando serve un'azione di chi guarda, in uno di questi
  casi (solo dati che lo schermo ha già, nessun campo nuovo dal server):
  - c'è una domanda dell'AI e `canAnswer`;
  - c'è un piano da approvare e `canDecide`;
  - una PR aspetta una persona: `cycle.state` fermo al tetto o correzione
    fallita, oppure in pausa per budget con `canResume` vero;
  - la review chiede modifiche e il ciclo automatico è spento
    (`changes_requested`).
- **Attività**: il numero dei commenti («Attività · 4»), senza pallino.
- Contenuto e Dettagli: niente.

## 5. La card della PR (tab Stato)

Una card per PR (esempio vero, ticket #1 di Stubwise Test):

```
┌─ stubwise-test · PR #4 ↗ ───────────┐
│  ● APPROVATA DALLA REVIEW           │
│  pronta per il merge                │
│  ultima richiesta: Alessandro       │
│  Locatelli su Bitbucket · 2 h fa    │
│  [        Chiedi modifiche        ] │
└─────────────────────────────────────┘
```

1. **Titolo**: repository · «PR #N», tutto toccabile, apre la PR sulla
   piattaforma (sostituisce il link «Open the PR →»). Con la PR mergiata o
   chiusa, un'etichetta accanto.
2. **Chip di stato**, maiuscolo e colorato col tono di oggi (verde approvata;
   giallo in correzione / in attesa / in pausa; rosso fallita / fermo al
   tetto). È la prima cosa che si legge.
3. **Dettaglio** in grigio, solo se aggiunge qualcosa: «pronta per il merge»,
   «giro 2 di 3», «budget esaurito · chiedi a un maintainer», «parte quando
   finisce il lavoro in corso sul ticket».
4. **Chi ha chiesto l'ultima volta**, in grigio, col tempo relativo calcolato
   sul telefono da `lastRequest.at` (stesso criterio di `stalled.ts`: il server
   manda la data, mai un conteggio).
5. **Bottone a tutta larghezza**: «Chiedi modifiche» / «Riprendi la
   correzione», solo con `canRequestCorrection` / `canResume` + `heldJobId`
   come oggi; altrimenti assente.

Spariscono: il nome del branch (va nel livello tecnico, in Dettagli) e
l'eyebrow «Pull requests» (la tab lo dice già).

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
