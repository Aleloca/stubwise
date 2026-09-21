# Una card chiusa deve dire PERCHÉ (21 set 2026)

## §1 — Il problema (RISCRITTO il 21 set 2026)

⚠️ **La prima stesura di questa sezione descriveva una schermata che non
esiste più**, e va detto perché l'errore è istruttivo: avevo registrato come
fatto un'osservazione («sulla pagina Posta una riattribuzione fallita si legge
ignorata») senza verificarla nel codice. Verificato poi, riga per riga:
`/mail` sul web elenca solo CONVERSAZIONI dal 14 settembre, `mailDetailSchema`
`outcome` non ce l'ha, e nell'app `mailStatusLabelKey`/`mailStatusTone` non
hanno più chiamanti. **Nessuna superficie mostra più lo stato di una proposta
di posta.** Quell'«Ignorata» l'aveva mostrata un'app già compilata sul
telefono, non il codice di oggi.

Il problema vero è un altro, ed è più grande: **di una proposta non si sa più
che fine ha fatto.** Il 18 settembre una riattribuzione è fallita, la card è
sparita dall'inbox e non è rimasto niente da nessuna parte — ci siamo arrivati
leggendo il database. Un operatore non ha quel database.

E i motivi per cui una proposta si chiude non hanno niente in comune:

| `outcome.type` | cosa è successo davvero |
|---|---|
| `null` | il classificatore non ha trovato niente da proporre |
| `reassigned_to` | **l'hai spostata tu** su un altro progetto |
| `reassign_failed` | la rigenerazione è fallita (guasto tecnico) |
| `reassign_no_signal` | spostata, ma su quel progetto non c'era nulla da proporre |
| `superseded_in_thread` | superata da un messaggio successivo dello stesso scambio |
| `declined` (calendario) | hai rifiutato l'invito su Google |
| `triage_dismissed` | hai detto «nessuno di questi» allo smistamento |

Le prime due righe sono la distanza del problema: *«non c'era niente»* e
*«l'hai spostata tu»* si leggono **identiche**. E `reassign_failed` — un
guasto — si legge come una scelta.

**Perché conta ora**: da novembre chi userà questa pagina non ha scritto il
codice né la mail. «Ignorata» su una card che invece è fallita è
un'informazione sbagliata, non una mancante: porta a non riprovare.

## §2 — La decisione: si cambia la LETTURA, non lo stato

`email_proposals.status` resta `ignored` per tutti questi casi, e va bene:
**lo stato dice cosa si può ancora fare con la riga** — qui sempre la stessa
cosa, riproporre — **e l'esito dice perché ci è arrivata**. È la forma già
scelta due volte (`declined`, `superseded_in_thread`), ed evita di pagare un
valore nuovo in `mailItemStatusSchema`, che l'app già installata legge.

**Dove si mostra** (decisione del maintainer, 21 set): **nella conversazione,
accanto a ogni messaggio** — è il posto dove uno legge lo scambio e si chiede
«e questa?». Non sulla card in inbox: per una proposta fallita la card è già
chiusa, e «gestita» è una parola che stona su un guasto.

⚠️ **NON è "solo client", come diceva la prima stesura.** `mailItemSchema` ha
`outcome`, ma quella risposta non la legge più nessuno: la conversazione passa
da `mailThreadMessageSchema`, che porta `proposalIds` e `reproposals` ma non
l'esito. Serve **un campo nuovo in quella risposta** — additivo,
`.default([])`, col test che parsa senza.

La buona notizia è che il server **già guarda** lo stato di quelle proposte:
gli serve per calcolare `reproposals`. E vale qui la stessa regola scritta nel
docblock di quel campo: **è il SERVER a decidere cosa mostrare**, non il
client a dedurlo da `status` — due copie della regola divergono, e la copia
sbagliata sta nel client.

## §3 — Regole di resa

1. **Una riga sotto il messaggio**, per ciascuna proposta nata da lì: cosa è
   successo, e — se la proposta è riproponibile — il bottone che già esiste.
   Quando un messaggio ha più proposte (fan-out su più progetti) le righe sono
   più d'una: il progetto va nominato, o non si capisce di quale si parla.
2. ⚠️ **Un tipo sconosciuto NON deve rompere né sparire**: si mostra lo stato
   nudo, come oggi. Non è teorico — in produzione ci sono 29 righe con
   `bulk_closed_automated`/`bulk_closed_stale_routing`, esiti che **nessun
   codice produce**: li ho scritti io a mano chiudendo l'arretrato del 17
   settembre. Un `Record` esaustivo qui andrebbe in crash sul dato vero.
3. **`reassign_failed` si distingue a vista** dagli altri: è l'unico che
   segnala un guasto, ed è l'unico su cui «Riproponi» è la risposta giusta.
4. **Nessuna prosa generata**: tutte le etichette da template i18n, come il
   registro decisioni. Il nome del progetto in `reassigned_to` si risolve
   dall'elenco progetti, e se non si risolve si scrive l'etichetta senza nome
   invece di mostrare un UUID.

## §4 — Cosa NON si fa

- **Non si aggiungono stati**: vedi §2.
- ~~**Non si tocca il server**: il dato c'è già.~~ ⚠️ **Falso, ed è rimasto
  dalla prima stesura**: `mailItemSchema.outcome` esiste ma quella risposta
  non la legge più nessuno, quindi serve un campo nuovo in
  `mailThreadMessageSchema` — vedi §2, riscritto. Lasciato barrato e non
  cancellato perché un lettore che trovasse solo la versione nuova non
  saprebbe che questa riga c'era: è lo stesso motivo per cui §1 dice come ci
  si è sbagliati invece di limitarsi alla correzione.
- **Non si mappano gli esiti delle card ANDATE A BUON FINE** (`backlog_item`,
  `milestone_created`, `commented`…): lì «Eseguita» è già corretto e dice ciò
  che serve. Questo design è sulle card CHIUSE SENZA azione, che sono quelle
  che confondono.
