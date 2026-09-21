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
— e sul web hanno già la coda di rilascio (fase 8).

**Vanno in un campo A SÉ, non nei due secchi esistenti** (correzione del 21
set, verificata sullo schema). La prima stesura diceva «`waitingForYou` per un
maintainer, `waitingForOthers` per un operatore»: **non è implementabile**.
`pulseWaitingForYouItemSchema.notificationId` è `z.uuid()` **obbligatorio** —
è la riga d'inbox su cui agire — e una PR che aspetta il merge **non ha una
notifica**, deliberatamente (fase 8: «`/release` non è raggiunta da inbox»,
nessun kind nuovo; e il §5 qui sotto vieta notifiche nuove).

Le tre uscite, e perché due sono chiuse:

- **rendere `notificationId` opzionale** → è la direzione NON sicura
  dell'invariante sui cambi additivi: l'app installata ha quel campo
  obbligatorio compilato dentro, quindi una risposta senza fa fallire il parse
  dell'**intera** risposta e il polso sparisce su ogni telefono. Identica alla
  lezione di `push` in fase 4;
- **una notifica per le PR** → contraddice la fase 8 e il §5;
- **un campo nuovo**, additivo, `.default([])`, con un booleano `canMerge`
  calcolato **lato server** col controllo di ruolo. Il client lo mostra sotto
  «aspetta te» quando `canMerge`, sotto «aspetta altri» quando no.

La terza ottiene tutto ciò che questa sezione vuole — collocazione dipendente
dal ruolo, l'operatore che non vede come «sua» una cosa che non può fare, il
test a due ruoli sugli stessi dati — **senza toccare un campo che le app
installate esigono**. Un'app vecchia riceve un campo in più e lo ignora.

Quindi «fermo» è: ticket **non chiuso**, **senza job vivo**, **senza PR
aperta**, **senza domanda dell'agente in sospeso**. Cioè: nessuno ci sta
lavorando e nessuno sta aspettando nessun altro. Sui dati di oggi: 6 ticket.

Ogni voce porta **da quanti giorni** e **perché è ferma**.

⚠️ **Il motivo si deriva dai JOB, non dallo stato** — correzione del 21 set,
dai dati veri. Una prima stesura diceva «`in_progress` senza job → lavoro
cominciato e interrotto, il caso peggiore», citando #25 come esempio. **È
falso**: #25 ha **zero** job, `created_at` e `updated_at` a tre secondi di
distanza, e il suo contenuto (Fase 7) è **in produzione dal 9 settembre**. Non
è un lavoro interrotto: è uno stato messo a mano su lavoro che nel frattempo è
stato fatto altrove.

La distinzione è la lezione: **lo stato è una DICHIARAZIONE di qualcuno, i job
sono un FATTO.** Una vista che legge solo lo stato manda un operatore a
cercare lavoro che non esiste — il falso positivo peggiore per questa
funzione, e capitava proprio sull'esempio che la motivava.

Quindi:

- `open`, mai un job → «da preparare»;
- `open`, un job finito → «lavorato, poi fermo»;
- `in_progress` **con** un job non concluso → «interrotto» (il caso vero:
  oggi in produzione **non ce n'è nessuno**);
- `in_progress`/`in_review` **senza nessun job** → «stato dichiarato, nessun
  lavoro registrato» — e **non** si promette che ci sia qualcosa da fare: può
  essere un ticket da chiudere, come #25 e #97. L'azione giusta lì è spesso
  «chiudilo», non «lavoraci», e l'etichetta non deve suggerire il contrario.

## §4 — L'ordine è per ANZIANITÀ, e il numero è un fatto

Le voci si ordinano dal più fermo, e il numero di giorni si mostra sempre.
Non è decorazione: è ciò che distingue «tre giorni, normale» da «ventuno
giorni, qualcuno se n'è dimenticato». Senza, il secchio diventa un elenco
piatto con un nome diverso — cioè la cosa che il §2 ha scartato.

**Nessuna soglia che nasconde**: un ticket fermo da un giorno compare lo
stesso, in fondo. Una soglia sarebbe una decisione su cosa conta presa dal
codice invece che da chi guarda.

⚠️ **E i giorni si contano dall'ultimo MOVIMENTO, non dalla creazione.** Sul
web la riga del ticket (`ticket-row.tsx`) mostra `formatRelativeTime(createdAt)`
— l'ETÀ — mentre `updatedAt` è già nello schema e non viene usato. È peggio
del non mostrare niente: un ticket aperto due mesi fa e lavorato ieri legge
«2 mesi fa» e **sembra** fermo. Non è un'informazione mancante, è
un'informazione che si scambia per quella che serve — la stessa famiglia di
«ignorata» su una proposta fallita.

## §5 — Cosa NON si fa

- **Niente notifiche nuove**: il pulse proattivo (fase 2) già avvisa quando un
  PROGETTO è fermo; questo è a livello di ticket e vive in una vista, non in
  inbox — che stiamo cercando di alleggerire, non di riempire.
- **Nessun elenco filtrabile** (§2).
- **Niente soglie configurabili**: un'impostazione in più da capire, per una
  domanda che il numero di giorni già risponde.
- **Non si tocca `/release`**: le PR aperte restano lì, e questo secchio le
  esclude apposta (§3).
