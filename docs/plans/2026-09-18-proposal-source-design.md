# Far vedere cosa ha generato una proposta (18 set 2026)

## §1 — La richiesta, e perché non è cosmetica

Maintainer, 18 settembre, dopo aver usato la riattribuzione:

> «Nel dettaglio di un inbox sarebbe molto comodo poter vedere il dettaglio di
> cosa lo ha generato, perché altrimenti leggo solo i proposal ma senza sapere
> cosa lo ha scaturito non riesco a capire se hanno senso e quale scegliere.»

Oggi `GoogleProposalScreen` (app) mostra mittente, oggetto, tipo di segnale, la
domanda e le scelte con le loro conseguenze. **Non una riga di quello che c'era
scritto nella mail.** L'unico rimando al contenuto è `messageUrl`, che porta
FUORI, su Gmail.

Il punto non è la comodità: è che **una proposta senza la sua fonte è
un'affermazione che non si può verificare**. Chi decide deve poter dire «sì,
l'ha capita» o «no, ha frainteso» — e da novembre a decidere saranno operatori
che non hanno scritto loro quella mail.

## §2 — Cosa mostrare: il testo che il MODELLO ha letto

Non l'email come si vede in Gmail: **`email_messages.text_excerpt`**, cioè
esattamente il testo passato alla classificazione.

La distinzione è il valore di questa funzione, non un dettaglio:

- l'estratto è **troncato** a `CLASSIFY_TEXT_MAX_CHARS`, e di un thread la
  classificazione guarda **l'ultimo messaggio ammesso**, non tutti;
- quindi se i suggerimenti sembrano fuori bersaglio, la fonte spiega spesso il
  perché — il modello ha letto meno di quanto c'è.

Mostrare l'email intera nasconderebbe proprio questo. È la stessa distinzione
già scritta in CLAUDE.md fra `text_excerpt` («ciò che la CLASSIFICAZIONE ha
letto») ed `email_bodies` («una copia per CHI LEGGE»): questa schermata vuole
il primo.

Sotto l'estratto, un rimando **«apri la conversazione»** verso MBX per chi
vuole il resto: la lettura completa ha già la sua schermata e non si duplica.

## §3 — L'anello mancante, e perché va risolto a LETTURA

La rotta esiste già: `GET /api/me/mail/:source/:id`
(`apps/server/src/routes/me-mail.ts`) restituisce `textExcerpt` ed è già
ristretta al proprietario della casella (`resolveEmailMessage(db, user.id, …)`).

Manca che la card sappia **quale** messaggio: l'evento della notifica porta
`proposalId`, `from`, `subject`, `messageUrl` — **non l'id del messaggio**.

⚠️ **E non si aggiunge all'evento.** Le azioni e i campi dell'evento sono
persistiti nel jsonb al momento della publish: un campo nuovo lo avrebbero solo
le card pubblicate DOPO, e quelle già in inbox resterebbero senza per sempre.
È esattamente l'errore che abbiamo fatto il 17 settembre con
`reassign_project`, scoperto solo quando il maintainer ha aperto una card
vecchia e non ha trovato il bottone.

**Si deriva a lettura**: `readGoogle` (`apps/server/src/services/inbox.ts`)
risolve l'id del messaggio dalla riga `email_proposals` che possiede la
notifica e lo aggiunge alla risposta di `/api/inbox`. Vale per tutte le card,
vecchie e nuove, senza toccare una riga di dati.

**Solo l'id, non il testo**: l'estratto si chiede quando si apre il dettaglio,
non per ogni card della lista. Una lista d'inbox con 30 card non deve
trasportare 30 estratti per mostrarne uno.

### §3bis — La derivazione non raggiunge le card vecchie: le RIPARA

⚠️ Sezione aggiunta il 18 set 2026 in corso d'implementazione, su un fatto del
sistema che nessuno dei due conosceva prima di leggere il codice.

Il §3 qui sopra dice che l'evento non porta l'id del messaggio. **Due
precisazioni, e la seconda cambia il valore di tutta la scelta.**

**(1) L'id giusto non è quello del messaggio.** `GET /api/me/mail/:source/:id`
(`resolveEmailMessage`, `apps/server/src/routes/me-mail.ts`) per
`source === "email"` cerca `eq(emailProposals.id, id)`: vuole un
**`email_proposals.id`**, non un `email_messages.id`. Solo il ramo
`email_triage` accetta un id di messaggio, ed è la semantica dello smistamento
— che CLAUDE.md vieta di confondere con quella delle proposte figlie. Il campo
si chiama quindi `sourceProposalId`.

**(2) Il jsonb, su questo, è inaffidabile anche quando c'è.** L'evento porta
già un `proposalId` che *dovrebbe* essere `email_proposals.id` — ma lo è solo
dalle card pubblicate dopo il fix di App M3 Fase C. Prima, `assembleEvent`
(`apps/worker/src/google/proposal.ts`) ci scriveva un `randomUUID()` senza
relazione con nessuna riga: su quelle card il campo dell'evento **non apre
nessun dettaglio**.

Quindi la derivazione a lettura non serve solo a dare il campo alle card
pubblicate prima di questa funzione: **ripara anche quelle il cui payload
porta un id sbagliato**. È un argomento più forte di quello del §3, e vale la
pena conoscerlo prima di essere tentati di «ottimizzare» leggendo
`event.proposalId` invece di interrogare il database.

**Il test che fissa la differenza** (`apps/server/src/services/inbox.test.ts`,
«CARD VECCHIA») asserisce due cose, non una: che il valore derivato sia quello
giusto, **e che NON coincida con quello del jsonb**. Senza la seconda,
passerebbe anche un'implementazione che legge dall'evento — cioè proprio
quella che questa sezione esiste per escludere.

## §4 — Il calendario resta fuori, e si dice perché

Una proposta di calendario **non ha una classificazione AI** (`mailSignalSchema`
è «assente sugli eventi di calendario: non c'è AI»): nasce da regole sul titolo
e sui partecipanti. «Cosa ha letto il modello» lì non vuol dire niente, e
scriverlo sarebbe una bugia gentile.

Chi vuole il dettaglio di un appuntamento ha già `/calendar` col suo pannello.
Se un domani servisse anche lì, la domanda è un'altra — «da quale regola è
nata questa proposta?» — e merita un design suo.

## §5 — Privacy: niente di nuovo, ma va verificato

Il testo di un'email è privato del proprietario della casella. Due cose devono
restare vere, e nessuna delle due è un requisito nuovo:

1. la rotta del dettaglio filtra già su `google_accounts.user_id` e **nessun
   ruolo scavalca**, nemmeno un admin (audience `mailbox_owner`, fase 6);
2. l'id del messaggio aggiunto alla risposta d'inbox non allarga niente: una
   card `google.proposal` è già recapitata al solo proprietario della casella,
   e `shouldSendWebhook` la tiene fuori dai canali condivisi.

Il test deve verificarlo **negativamente**: un altro utente che chieda quel
messaggio non lo ottiene, e la sua inbox non contiene quell'id.

## §6 — Cosa NON si fa

- **Non si conserva niente di nuovo**: nessuna colonna, nessuna migrazione.
  L'estratto è già in `email_messages`, la rotta già esiste.
- **Non si mostra l'HTML originale**: quello passa da «Leggi l'originale»
  nella conversazione, con la sua sanificazione e il suo iframe. Qui serve il
  testo, non la resa.
- **Non si tocca `messageUrl`**: il rimando a Gmail resta per chi lo vuole.
