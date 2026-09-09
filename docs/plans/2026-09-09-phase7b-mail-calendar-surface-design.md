---
title: Fase 7b — Posta e Calendario dentro la piattaforma
date: 2026-09-09
stubwise:
  project: stubwise
---

# Fase 7b — Posta e Calendario dentro la piattaforma

## 1. Perché questa fase esiste

Il 9 settembre 2026 l'inbox del maintainer ha ricevuto **485 notifiche in
quattro ore**, e altre 230 erano in coda. Nessuna era un errore di
implementazione: erano il comportamento corretto di un disegno sbagliato.

Un solo appuntamento ricorrente del calendario — «Pianificazione task» — è
stato espanso da Google in **730 occorrenze singole, dal 2021 al 2035**, e
ognuna è diventata una proposta di milestone. 259 sono arrivate come push sul
telefono, 226 sono fallite perché APNs ha smesso di accettarle.

La causa prossima sono tre difetti tecnici (§5). La causa vera è un'altra: la
fase 6 ha progettato **l'ingestione** — leggere posta e calendario, capirci
qualcosa, proporre azioni — e non ha mai progettato la **superficie** per
guardare quella roba e configurarla. Non esiste una sezione Calendario. La
pagina Posta esiste ma è un elenco di righe che rimandano a Gmail: il testo
delle email è già in database e non viene nemmeno selezionato.

Senza una superficie, l'unico modo che il sistema ha di dirti qualcosa è la
notifica — e l'unico modo che hai tu di configurarlo è non averlo. Questa fase
chiude quel buco, e i tre difetti del calendario ci stanno dentro come
conseguenza, non come lavoro a sé.

## 2. Cosa c'è oggi, verificato

**Posta.** `email_messages` (`packages/db/src/schema.ts:3217-3280`) conserva
`text_excerpt` (`:3233`): fino a **20.000 caratteri** di testo già ripulito —
plain se c'è, altrimenti l'HTML convertito, con citazioni e firma tolte
(`MAX_TEXT_LENGTH`, `packages/google/src/gmail.ts:24`). Il modello ne vede
8.000 (`CLASSIFY_TEXT_MAX_CHARS`, `apps/worker/src/google/classify.ts:109`).
**Non** si conservano: HTML originale, allegati, Cc/Bcc, MIME grezzo — letti
per routing e ammissione, poi scartati (`sync.ts:262-281` scrive solo
from/to/subject/labels/threadId).

`apps/server/src/routes/me-mail.ts` espone **tre rotte**: lista (`:476`),
sommario (`:533`), riproponi (`:658`). Nessuna rotta di dettaglio, e
`text_excerpt` **non è mai selezionato** — non compare in `apps/server`,
`apps/web` né `packages/shared`. `mailItemSchema`
(`packages/shared/src/schemas/google.ts:448-489`) non ha nessun campo di corpo.
La pagina (`apps/web/src/routes/mail.tsx:266-268`) mostra una riga sola,
`mittente — oggetto`, e un link a Gmail costruito da `gmailThreadUrl`
(`me-mail.ts:181-183`).

`getMessageFull` (`packages/google/src/gmail.ts:263`) **esiste già** ed è una
funzione pura di rete, non legata al poller: rileggere un messaggio per id si
può fare oggi, e `gmail.readonly` (`packages/google/src/oauth.ts:37-38`) basta
per il corpo e per gli allegati.

**Calendario.** `calendar_events` (`schema.ts:3294-3329`) ha `google_event_id`
per OCCORRENZA, unique `(account_id, google_event_id)` (`:3322`), e **nessuna
traccia della serie**: niente `recurring_event_id`, `ical_uid`, `rrule`,
`original_start_time`. L'unico legame fra occorrenze è il `fingerprint`
(`giorno + titolo`, `apps/worker/src/google/calendar.ts:156`), che per
costruzione è **diverso** per ogni occorrenza — è pensato per lo stesso
appuntamento duplicato, non per lo stesso appuntamento ripetuto.

La chiamata a Google è `singleEvents=true`
(`packages/google/src/calendar.ts:127`), quindi Google **manda già**
`recurringEventId` e `originalStartTime` su ogni istanza. Li perdiamo noi: lo
zod `eventSchema` (`:44-54`) non li dichiara e `toEvent` (`:75-95`) non li
mappa. Si perdono anche `iCalUID`, `recurrence` (la RRULE), `location`,
`eventType`; `description` sopravvive nel tipo ma non è persistita.

Non esiste sezione Calendario in nessuna forma. `NAV_ITEMS`
(`apps/web/src/components/app-layout.tsx:27-44`) non ha una voce, e non c'è una
rotta.

**ACL.** La posta è rigidamente personale: `user_id` è nel WHERE di **ogni**
query di `me-mail.ts` (`:219, :314, :389`, tutte le count `:557-603`, il
repropose `:677, :694, :718`), e il docblock (`:30-38`) lo dichiara — nessun
ruolo scavalca il filtro, nemmeno un admin; una riga altrui dà pagina vuota o
404, mai 403. L'audience `mailbox_owner` produce un solo destinatario e non
esce mai su webhook d'istanza (CLAUDE.md, «L'audience `mailbox_owner` non
include MAI gli admin»). **Il calendario eredita questa proprietà**: è il
calendario di una casella, non di un progetto.

**Retention.** `GMAIL_RETENTION_DAYS` (default 90,
`apps/worker/src/config.ts:837-844`) e `pruneOldEmails`
(`apps/worker/src/google/poller.ts:1606-1657`) cancellano la **riga intera** —
quindi anche `text_excerpt`, oggetto e mittente.

## 3. La posta si legge in Stubwise

Una vista di dettaglio, raggiungibile dalla lista e dalla card d'inbox.

**Due fonti, in quest'ordine** (decisione del maintainer, 9 set 2026):

1. **L'estratto già in database**, mostrato subito. Nessuna chiamata di rete,
   nessun token da rinnovare, funziona anche se Google è irraggiungibile o se
   il collegamento della casella è scaduto. È il testo che ha visto il
   classificatore, il che ha un valore in sé: si legge esattamente ciò su cui
   la proposta si è formata.
2. **Il messaggio originale su richiesta**, dietro un comando esplicito, letto
   con `getMessageFull`. Serve per gli allegati, i Cc e la formattazione, che
   in database non ci sono. Non si persiste nulla di ciò che si rilegge: la
   rilettura è una finestra su Gmail, non una copia.

La distinzione va **detta all'utente**, non lasciata implicita: l'estratto
dichiara di essere un estratto («testo ripulito, senza citazioni, firma e
allegati»), e il comando di rilettura dichiara che sta chiedendo il messaggio a
Google adesso. È la stessa disciplina del consenso informato della fase 6c: chi
legge deve sapere cosa sta leggendo.

**Il limite dei 90 giorni va detto anche lui.** La potatura cancella la riga
intera: un'email di quattro mesi fa non è «vecchia», è **sparita**, e la
sezione non può fingere il contrario. Alzare o togliere la retention è una
scelta che resta al maintainer e non entra in questa fase (§8).

## 4. La sezione Calendario

Nuova voce di primo livello, **personale** come la Posta e con la stessa ACL.
Tre cose, in una pagina:

- **Gli appuntamenti visti**, con lo stato della proposta che ne è nata e il
  suo esito. È l'equivalente della pagina Posta per il calendario, che oggi
  semplicemente non ha una superficie.
- **Le serie ricorrenti riconosciute**, ciascuna con la sua configurazione.
- **Le occorrenze passate restano visibili** ma non producono più nulla: le 730
  righe chiuse il 9 settembre compariranno come una serie spenta, che il
  maintainer può accendere se vuole.

### Le serie

`recurringEventId` entra nella normalizzazione (`eventSchema` + `toEvent`) e
diventa una colonna `recurring_event_id` su `calendar_events`, nullable — un
appuntamento singolo non ha serie, ed è la maggioranza.

Una tabella nuova `calendar_series`, chiavata su
`(account_id, recurring_event_id)`, tiene la configurazione:

| Campo | Significato |
|---|---|
| `enabled` | **Default `false`.** Una serie non produce nulla finché non la si accende. |
| `project_id` | Il progetto, **fissato all'attivazione** |
| `action` | `backlog_item` \| `milestone` \| `reminder` |
| `lead_days` | Quanti giorni prima dell'occorrenza (0–30, default 2) |
| `auto` | `false` = ti propone e decidi tu; `true` = esegue e ti dice cosa ha fatto |

**Il progetto si fissa, non si ri-deduce.** Le regole di routing decidono a
ogni occorrenza, e per una serie questo è imprevedibile: la stessa riunione
settimanale finirebbe su progetti diversi a seconda di chi è stato invitato
quella volta. Una riunione ricorrente appartiene a un progetto; lo si dice una
volta.

**Default spento, e non è un dettaglio di prudenza.** È la lezione delle 730
notifiche: il costo di una serie accesa per sbaglio si moltiplica per il numero
di occorrenze, che può essere centinaia. Una serie nuova che compare nel
calendario di qualcuno non deve poter fare niente da sola.

### L'azione automatica non fa mai partire lavoro

`auto: true` può creare una voce di backlog, una milestone o un promemoria.
**Non può avviare un job AI, e non deve poterlo fare in futuro.** È la stessa
linea della fase 7 — nessun lavoro parte senza che una persona lo decida — e
qui vale a maggior ragione: un'automazione ricorrente che avvia lavoro
ricorrente è il modo più diretto di riprodurre l'incidente delle 730 notifiche
in una forma che costa soldi invece che attenzione.

Un'azione automatica **si vede comunque**: chi ha la casella deve sapere cosa è
stato creato a suo nome, senza dover andare a cercarlo.

### Nessun kind di notifica nuovo

Vincolo di progetto, non una preferenza. Aggiungere un valore a
`notificationKindSchema` è la trappola documentata in CLAUDE.md per le fasi 2,
5 e 6: un enum chiuso, un binario vecchio che non conosce il valore,
`inboxPageSchema` che fallisce e **tutta `/api/inbox` che salta con un 500** —
non una card degradata. Le proposte delle serie riusano `google.proposal` con
`source: "calendar"`, che esiste già: quale azione eseguire lo dice la
configurazione della serie, letta dalla riga, non un valore nuovo nel payload.

Vale anche per i valori: **niente valori nuovi in `ProposalSource.source`**
(`apps/server/src/services/google-proposal.ts:222-234`), per la stessa ragione.

## 5. I tre difetti del calendario

Vanno chiusi qui perché sono la stessa materia, non un lavoro a parte.

**(a) La finestra non è applicata in ingresso.** `calendarWindow`
(`apps/worker/src/google/calendar.ts:118`) produce `now → now + 60 giorni` e
serve **solo a comporre la richiesta** a Google. Con un `syncToken` la finestra
non si può nemmeno mandare (`packages/google/src/calendar.ts:126-129`, e il
commento lo dice), quindi il giro incrementale riceve tutto. Il ciclo che filtra
in memoria (`apps/worker/src/google/poller.ts:1049-1057`) guarda `isCancelled`,
`startsAt` mancante, `buildMilestoneProposal` nullo e `inScope` — **mai la
finestra**. Da solo, questo controllo avrebbe evitato 728 righe su 730.

**(b) Le serie non sono riconosciute.** §4. Senza `recurringEventId` ogni
occorrenza è un evento indipendente e nessuna regola può distinguerle.

**(c) Il fingerprint non discrimina le ricorrenze, e non deve.**
`computeFingerprint` (`calendar.ts:156`) è `giorno + titolo`: due occorrenze
della stessa serie cadono in giorni diversi, quindi sono legittimamente
distinte. Non va «riparato» — fa esattamente il lavoro per cui esiste
(riconoscere lo stesso appuntamento ricreato con un id nuovo). La ricorrenza è
un'altra domanda e vuole un altro meccanismo.

**Nota sull'`inScope` deprecato.** Il calendario è l'ultimo consumatore di
`EmailRoutingResult.inScope` (`packages/notifications/src/email-routing.ts:81-90`,
usato a `poller.ts:1054`): la fase 6c ha spostato la posta su `admit()` e ha
lasciato il calendario indietro. Questa fase **non** ci mette mano: è un
riordino a sé, e mescolarlo alla superficie renderebbe il diff illeggibile.
Resta annotato in §8.

## 6. Migrazione, rollback, privacy

**Migrazione 0073**, additiva, un solo batch, **nessun `ALTER TYPE`** (quindi
nessuna trappola della transazione unica): colonna `recurring_event_id` su
`calendar_events` (nullable), tabella nuova `calendar_series`.

**Rollback.** Nessun kind di notifica nuovo e nessun valore nuovo in un enum
esistente (§4), quindi **non** si ripresenta il 500 su `/api/inbox` delle fasi
2/5/6. Scendere di immagine è sicuro: le rotte nuove diventano 404, la colonna e
la tabella restano inerti, il migratore ignora la 0073 già applicata. Il caddy
va sceso insieme al server, come sempre. La strada innocua per spegnere le serie
senza toccare niente è metterle tutte `enabled = false` dalla UI.

**Privacy.** La sezione Calendario eredita l'ACL della posta, per intero: ogni
query filtra sull'utente proprietario della casella, nessun ruolo scavalca, e
niente di ciò che si vede lì esce su un webhook d'istanza. Un maintainer non
vede il calendario di un collega, come già non ne vede la posta. Chi aggiunge
una rotta a questa sezione la scrive con `user_id` nel WHERE, come le sei
esistenti.

## 7. Cosa NON entra

- **Rispondere a un'email da dentro Stubwise.** Lo scope è `gmail.readonly` e
  resta tale: scrivere richiederebbe un permesso nuovo e un consenso nuovo.
- **Gli allegati scaricati e conservati.** La rilettura mostra che ci sono e
  permette di aprirli su Gmail; non li portiamo dentro.
- **Il riordino di `inScope`** per il calendario (§5).
- **Alzare o togliere la retention dei 90 giorni**: è una scelta del
  maintainer, con un costo in spazio, e va decisa guardando i numeri veri dopo
  che la sezione esiste.
- **Il calendario come sorgente di più progetti** (l'equivalente della fase 6b
  per la posta): resta uno-a-uno.
