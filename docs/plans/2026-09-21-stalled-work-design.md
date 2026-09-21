# Far vedere ciò che è fermo (21 set 2026)

## §1 — Il buco, misurato

Nell'app si arriva a un ticket solo da una notifica, da una voce del polso o
— dal 16 settembre — dalla ricerca. Il polso mostra tre secchi
(`waitingForYou`, `waitingForOthers`, `running`) **tutti basati su un JOB in
volo**, più le voci di backlog pronte.

Conseguenza sui dati veri, 21 settembre:

| ticket | stato | PR aperta | dall'APP | dal WEB |
|---|---|---|---|---|
| #20 #23 #26 #31 | `in_review` | **sì** | — | `/release` + elenco ticket |
| #97 | `in_review` | no | — | elenco ticket |
| #18 #19 #27 #29 | `open` | no | — | elenco ticket |
| #25 | `in_progress` | no | — | elenco ticket |

**Dieci ticket non chiusi, zero con un job vivo, quindi zero nel polso.** Il
più vecchio fermo da **21 giorni**.

⚠️ **Una prima stesura di questa sezione diceva «invisibili da NESSUNA
superficie». È falso, e l'ho verificato solo dopo averlo scritto**:
`apps/web/src/routes/tickets/index.tsx` è un elenco ticket completo, con
filtri, che di default mostra gli stati attivi. Sul web quei dieci ci sono
tutti. È il terzo caso in una settimana di un'affermazione registrata senza
guardare il codice (gli altri due: «la pagina Posta legge ignorata», e la
premessa del design del 21 set) — scritto qui perché chi legge sappia che
questa sezione è stata corretta, non nata giusta.

**Il buco vero, più stretto ma non meno reale:**

1. **Dall'app non si raggiungono affatto.** Ed è l'app che useranno gli
   operatori da novembre.
2. **Sul web sono in un elenco che non distingue «fermo» da «attivo».** Un
   ticket `open` da 21 giorni e uno aperto stamattina stanno nella stessa
   lista, senza che niente dica quale dei due ha smesso di muoversi. L'elenco
   risponde a «quali ticket ci sono», non a «cosa si è fermato».

La ricerca (16 set) apre i ticket, ma risponde a «dov'è quella cosa che so
esistere», non a «cosa è fermo e aspetta me». Chi apre l'app senza una
notifica in mano non ha ancora niente da leggere — e sul web trova un elenco
che gli chiede di sapere già cosa cercare.

**Perché ora**: da fine ottobre saranno operatori non tecnici a far avanzare
questi lavori. Un ticket fermo da tre settimane che nessuna schermata nomina
non è «arretrato»: è lavoro perso.

## §2 — La decisione: un quarto secchio, non un elenco

Scelta del maintainer, 21 settembre, sull'anteprima.

Il polso del progetto guadagna **«fermo»** accanto ai tre esistenti. **Non**
un elenco dei ticket: l'architettura dell'app (11 set 2026, decisa per tutte
le fasi) dice «niente elenco piatto», e la ragione regge — un elenco
filtrabile è navigazione da gestionale, e chi deve agire non sa da dove
cominciare. Un secchio invece risponde a una domanda: *cosa non si sta
muovendo qui?*

## §3 — Cosa conta come «fermo», e cosa NO

⚠️ **I quattro con una PR aperta non sono fermi**, e metterli lì darebbe
l'informazione sbagliata: quelli **aspettano una decisione umana** — il merge
— e sul web hanno già la coda di rilascio (fase 8). Vanno in
`waitingForYou` **per un maintainer** (che può mergiare) e in
`waitingForOthers` per un operatore (che non può: è un divieto, CLAUDE.md).

Quindi «fermo» è: ticket **non chiuso**, **senza job vivo**, **senza PR
aperta**, **senza domanda dell'agente in sospeso**. Cioè: nessuno ci sta
lavorando e nessuno sta aspettando nessun altro. Sui dati di oggi: 6 ticket.

Ogni voce porta **da quanti giorni** e **perché è ferma**, che non è la stessa
cosa dello stato:

- `open` senza piano → «da preparare»;
- `open` con piano salvato → «piano pronto, mai avviato»;
- `in_progress` senza job → **il caso peggiore**: un lavoro cominciato e
  interrotto, che oggi non compare da nessuna parte (è #25, fermo da 12
  giorni);
- `in_review` senza PR → «chiuso a metà»: lo stato dice revisione ma non c'è
  niente da rivedere.

## §4 — L'ordine è per ANZIANITÀ, e il numero è un fatto

Le voci si ordinano dal più fermo, e il numero di giorni si mostra sempre.
Non è decorazione: è ciò che distingue «tre giorni, normale» da «ventuno
giorni, qualcuno se n'è dimenticato». Senza, il secchio diventa un elenco
piatto con un nome diverso — cioè la cosa che il §2 ha scartato.

**Nessuna soglia che nasconde**: un ticket fermo da un giorno compare lo
stesso, in fondo. Una soglia sarebbe una decisione su cosa conta presa dal
codice invece che da chi guarda.

## §5 — Cosa NON si fa

- **Niente notifiche nuove**: il pulse proattivo (fase 2) già avvisa quando un
  PROGETTO è fermo; questo è a livello di ticket e vive in una vista, non in
  inbox — che stiamo cercando di alleggerire, non di riempire.
- **Nessun elenco filtrabile** (§2).
- **Niente soglie configurabili**: un'impostazione in più da capire, per una
  domanda che il numero di giorni già risponde.
- **Non si tocca `/release`**: le PR aperte restano lì, e questo secchio le
  esclude apposta (§3).
