# Spostare una proposta sul progetto giusto (17 set 2026)

## §0 — Da dove nasce, e un'onestà preliminare

Richiesta del maintainer, 16 settembre, dai test manuali sull'app:

> «Mi manca un'azione possibile da fare su un inbox, che sarebbe quella di
> cambiare il progetto a cui è stato assegnato automaticamente dai filtri.»
> «L'utente può spostarla sul progetto giusto, questo dovrebbe quindi anche
> far ripartire la generazione dei suggerimenti derivati da quella cosa perché
> magari su un progetto diverso abbiamo contesti diversi.»

⚠️ **Il caso che motivava la richiesta si è dissolto durante questa
progettazione**, e va scritto perché nessuno lo riscopra come una sorpresa. Il
16 settembre 18 proposte su 33 erano attribuite a Wilco, e sembrava un difetto
di attribuzione. Non lo era: il progetto Wilco aveva fra le sue regole tutti i
domini interni del maintainer, corrette da lui il 16 sera. Le 9 proposte
rimaste su Wilco erano tutte **antecedenti** a quella correzione (create fra il
9 e il 15 settembre, verificato sui timestamp) e sono state chiuse.

Al 17 settembre, delle 8 proposte aperte rimaste, **nessuna è sul progetto
sbagliato**. Questa funzione si costruisce quindi su un caso ragionato, non
osservato — decisione del maintainer, presa sapendolo. La prima cosa da
guardare quando arriverà il primo caso vero è se questa forma lo copre.

## §1 — Cosa serve

Da una proposta di posta in inbox, chi ha ricevuto la mail deve poter dire
«questa non è di Wilco, è di Carelli» e ottenere **una proposta nuova sul
progetto giusto, coi suggerimenti rifatti col contesto di quel progetto** —
non la stessa proposta con un'etichetta diversa.

## §2 — Perché non è un bottone che già esiste

`choose_project` c'è nello schema, ma **ha già due semantiche opposte** a
seconda di dove viene confermata (CLAUDE.md, invariante dedicata):

- su una proposta di **smistamento** (`source: "email_triage"`, il padre):
  attribuisce il messaggio e lo rimette in coda (`status: "new"`);
- su una proposta **figlia** (`source: "email"`, fase 6b): chiude la riga con
  esito `reassigned_project` e **non sposta** `email_proposals.project_id`.

L'invariante dice a chiare lettere di non unificarle. **Aggiungere una TERZA
semantica allo stesso nome sarebbe l'errore che quell'invariante esiste per
impedire**: serve un'azione nuova, con un nome suo.

E la strada del padre non è percorribile: rimettere `email_messages` in coda
riclassifica l'intero messaggio e azzera le proposte **sorelle** ancora aperte
su altri progetti — che la fase 6b protegge esplicitamente («confermare una
proposta non chiude le sorelle»).

## §3 — Il disegno

Un'azione nuova, `reassign_project`, offerta **solo** sulle proposte di posta
figlie (`source: "email"`): mai sul calendario (che non ha fan-out), mai su
uno smistamento (che ha già `choose_project`).

Alla conferma, in UNA transazione:

1. la proposta corrente si chiude con `status: "ignored"` e un esito che dice
   **dove è andata**: `{ type: "reassigned_to", projectId: <nuovo> }` — non un
   `ignored` generico, così chi rilegge la storia capisce cosa è successo
   (stessa forma di `superseded_in_thread` e `declined`);
2. nasce la riga per il progetto scelto, `status: "classified"` e
   `proposal_notification_id: null` — cioè nello stato in cui il poller la
   pubblicherà — con una `classification` che porta un **marcatore**:
   `{ reassignedFrom: <vecchio progetto>, needsReclassification: true }`;
3. il padre (`email_messages`) è toccato **solo** in `updated_at`, e le
   proposte sorelle non cambiano di una virgola.

Poi il worker, al giro successivo (`GMAIL_POLL_MINUTES`, 5' in produzione),
vede il marcatore **prima** di pubblicare, rifà la classificazione col contesto
del solo progetto scelto, riscrive `classification` e la pubblica.

### §3.1 — Perché un marcatore nel jsonb e non uno stato nuovo

`email_proposals.status` finisce dritto in `mailItemStatusSchema`
(`packages/shared/src/schemas/google.ts`), che **l'app mobile legge**. La
convenzione del repo è non pagarci un'etichetta: è la ragione per cui il
rifiuto sopravvenuto di un invito fu mappato su `ignored` invece di aggiungere
`declined` a quell'enum (CLAUDE.md, 15 set 2026).

Il precedente giusto è un altro, ed è nello stesso sottosistema: la fase 6c
marca una forma DIVERSA dello stesso campo `classification` col campo
`triage: true` — «non è un valore di enum né uno stato nuovo, solo una forma
diversa dello stesso jsonb, letta in modo tollerante da chi la rilegge».
Qui si fa lo stesso.

Costo: **zero migrazioni, zero colonne, zero enum toccati.**

### §3.1bis — Il progetto scelto viaggia dal client, e perché è legittimo

⚠️ Sezione aggiunta il 17 set 2026 in corso d'implementazione: la prima
stesura diceva «l'azione porta il `projectId` scelto», e **non sta in piedi**.

Le azioni sono PERSISTITE nel jsonb della notifica al momento della publish, e
il client ne sceglie una per INDICE: `AnswerGoogleProposalInput` ha
`notificationId`, `actor`, `optionIndex` e basta. Al momento della publish il
progetto di destinazione non è conoscibile — è proprio ciò che l'utente
sceglierà dopo. E persistere un'opzione per ogni progetto dell'istanza
gonfierebbe il jsonb di ogni card di posta per un caso raro.

**`AnswerGoogleProposalInput` guadagna quindi un `projectId`**, e il docblock
di `inboxGoogleActionSchema` va **corretto**, non aggirato in silenzio. Quel
testo dice: «il payload dell'azione NON esce mai da qui… l'indice scelto è
l'unico dato che viaggia verso il server», con la motivazione che altrimenti la
conferma diventerebbe «esegui quello che il client dice» invece di «esegui la
proposta che hai letto».

**Letta per il suo scopo, quell'invariante non copre questo caso, e il motivo
va scritto lì accanto**: protegge dal client che rimanda MODIFICATO un campo
della proposta che l'utente ha letto. Qui è il contrario — l'utente sta
scegliendo deliberatamente qualcosa che nella proposta non c'è, ed è tutto il
punto dell'azione. Non si sta eseguendo una proposta alterata: si sta
eseguendo un'azione il cui unico contenuto è una scelta umana.

Le tre condizioni che la tengono stretta, e vanno tutte e tre:

1. `optionIndex` resta **obbligatorio**: si conferma comunque un'opzione letta
   (quella «Sposta su un altro progetto»), non un comando arbitrario;
2. `projectId` è accettato **SOLO** quando l'azione risolta da quell'indice è
   `reassign_project`. Su qualunque altra azione è **rifiutato, non ignorato**
   — ignorarlo ne farebbe una porta di servizio che il prossimo che passa usa
   «tanto c'è»;
3. il server valida che il progetto **esista**, e l'ACL resta `mailbox_owner`:
   la proposta che nasce è visibile solo a chi possiede la casella, come
   quella che chiude.

**L'alternativa scartata**: una rotta a sé (`POST
/api/me/mail/email/:proposalId/reassign`), che non toccherebbe l'invariante e
avrebbe un precedente in `repropose`. Scartata perché `repropose` vive sulla
pagina Posta e **non** sulla card in inbox (CLAUDE.md lo dice esplicitamente):
replicare quel modello vorrebbe dire far uscire l'utente dalla card per
correggere un'attribuzione, che è esattamente il gesto che questa funzione
esiste per rendere immediato.

### §3.2 — L'esperienza, decisa

La card sparisce al tap, come per ogni altra azione dell'inbox; la proposta
rigenerata arriva quando è pronta, entro il giro del poller, con la sua
notifica. Nessuna card «in attesa» da guardare — sarebbe costata un valore
nuovo nell'enum che l'app legge, per un'etichetta.

Se il worker è fermo, la proposta nuova non compare: **identico a qualunque
proposta appena classificata**, non un caso speciale da gestire.

## §4 — I casi limite, tutti decisi

**Il progetto scelto ha GIÀ una proposta aperta su questo messaggio.**
L'insert esistente ha `onConflictDoUpdate` su `(email_message_id, project_id)`,
quindi tecnicamente «funzionerebbe» — sovrascrivendo una proposta legittima che
l'utente magari stava per confermare. **Non si fa**: l'azione rifiuta con un
errore esplicito (`already_proposed`), e la UI lo dice.

⚠️ **Il controllo va in DUE punti, e non è ridondanza** (17 set 2026, in corso
d'implementazione). Il claim (`propagateHandled`) gira PRIMA di
`dispatchAction`, e il chiamante su errore fa `markSourceFailed`: col solo
controllo dentro la transazione, chi sceglie un progetto che ha già una card si
ritroverebbe la card sparita e la proposta corrente in `failed` — recuperabile
solo con «Riproponi» dalla pagina Posta — per un gesto che non ha cambiato
niente. Serve quindi un **pre-check prima del claim** (così nel caso normale
non si brucia nulla) più quello **in transazione come autorità**, perché un
controllo fuori transazione è di per sé una corsa. È la stessa difesa in
profondità di `requireAdmin` sulla rotta più il ricontrollo nel servizio. Spostare su un progetto
che ha già la sua card non è una riattribuzione: è chiudere questa, e quella
c'è già.

**Il tetto sul fan-out** (`GMAIL_MAX_PROJECTS_PER_MESSAGE`, default 5) **non si
applica**: esiste per contenere il fan-out AUTOMATICO, non una scelta umana
esplicita su un singolo messaggio.

**Chi può farlo**: il proprietario della casella, come per ogni altra azione su
una proposta di posta — l'audience `mailbox_owner` non include gli admin, e
questa azione non fa eccezione.

**Il registro decisioni**: la riattribuzione registra una decisione, con un
**template i18n** (`decision.email.reassigned`) interpolato col nome dei due
progetti — mai prosa generata. Vale qui l'invariante di sempre: il registro
annota IL TAP, non il ragionamento del modello.

**Il messaggio non è più attribuito a nessuno?** No: `email_messages.project_id`
e `scope_project_ids` non si toccano. Sono ciò che il ROUTING ha dedotto, e
restano la memoria di cosa aveva capito il sistema — la correzione umana vive
sulla proposta, non riscrive la storia dell'attribuzione automatica.

## §5 — Compatibilità e rollback

Nessuna migrazione, nessun enum, nessun campo nuovo nelle risposte esistenti —
tranne l'azione in sé, che è un valore nuovo in `inboxGoogleActionTypeSchema` e
nel suo gemello `storedActionSchema`. **È la stessa famiglia di
`acknowledge_reminder` (fase 7b)**: entrambi i punti di lettura degradano con
`safeParse`, quindi un'app più vecchia non vede il bottone e non crasha.

Rollback del worker: una proposta col marcatore resta lì; un worker precedente
non lo riconosce e la pubblica **col contenuto vecchio sul progetto nuovo** —
degradata ma non rotta. Va detto, non nascosto.

Rollback del server: l'azione sparisce dalle card; le riattribuzioni già
richieste sono già righe in `email_proposals` e seguono il loro corso.

## §6 — Cosa NON fa

- **Non impara.** Spostare dieci mail dello stesso mittente da Wilco a Carelli
  non crea una regola di routing: le regole si toccano solo dal web, a mano, ed
  è giusto così finché una regola dedotta non è una decisione che qualcuno
  approva. (Candidato per un design futuro, non per questo.)
- **Non tocca il calendario.** Un evento non ha fan-out: lì «di chi è» ha
  ancora una risposta sola.
- **Non riapre il padre.** Mai `status: "new"` su `email_messages`: è la riga
  che azzererebbe le sorelle.
