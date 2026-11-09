# Shape brief — Scrivere dalla Posta

Superficie: la casella di scrittura della Posta — **Reply**, **Reply all**,
**Forward** in fondo alla conversazione aperta, **New email** nel pannello
di lettura (`#/mail?compose=new`, ⌘N in Mail) — con mittente, destinatari
con completamento, Cc, oggetto, corpo, allegati dal disco e dal Drive del
progetto, «Ask Claude» con indicazione facoltativa e streaming
interrompibile, bozze salvate per conversazione, **Send** con «Undo» per
5 s, inviata / fallita / «Retry». Piano: Task 8 (dati: Task 4). Spec: area
6 «Scrivere», «Allineamento» (scritture), «Quanto è vero nel prototipo»,
anti-obiettivo «Un'email che parte da sola». Elenco, lettura e proposte
sono di `mail.md`. Mondo: «Catalogo numerato», modalità **Operate**.
**[A n]** = scelta del brief, numerata in fondo.

## 1. Lavoro e pubblico

- **Chi**: chiunque con l'account Google collegato. Il commerciale che
  risponde al cliente sul preventivo, il Project Lead che inoltra al team
  la richiesta arrivata, l'assistenza che scrive al cliente che la
  consegna slitta. Molti non scrivono email «tecniche»: vogliono una
  risposta giusta, nel tono giusto, senza dover ricostruire a memoria lo
  stato del progetto.
- **Quando**: subito dopo aver letto (e spesso dopo aver confermato una
  proposta): «gli rispondo che ci pensiamo noi entro giovedì».
- Il motivo per cui scrivere sta in Stubwise e non su Gmail: **Claude
  conosce il progetto**. La bozza può dire «la task è in ritardo di due
  giorni, la consegna slitta a giovedì» perché vede le task, non solo
  l'email.

## 2. Esito e prova

- Azione primaria: rispondere a un'email in pochi secondi, partendo da una
  bozza di Claude o a mano, e spedirla con la certezza di poterla
  fermare se si è sbagliato.
- Successo: la casella è già nel punto in cui si sta leggendo (in fondo
  alla conversazione), con destinatari e oggetto giusti; «Ask Claude»
  riempie il corpo in streaming e la si può fermare a metà; dopo «Send»
  il messaggio compare nella conversazione come «Sending…» e per 5 s
  un «Undo» lo riporta in bozza **senza traccia**; un invio fallito dice
  perché e tiene il testo intatto.
- Verità del prodotto:
  - **Niente parte senza un clic su «Send»**: né la bozza di Claude, né
    una bozza salvata, né un «Retry» automatico.
  - **La bozza di Claude è una bozza**: riempie il campo, si modifica
    liberamente, non viene mai inviata da sola e usa solo ciò che chi
    scrive può vedere (task e progetti visibili a lui).
  - **I destinatari suggeriti** vengono dal team e dalle email che chi
    scrive vede, mai da posta altrui.
  - **Una bozza per conversazione**, salvata da sé: chiudere non perde
    niente.

## 3. Direzione scelta

- **Tesi**: la casella di scrittura è la **stessa casella della
  conversazione con Claude**, allargata a un modulo: bordo 1px
  `rule-strong`, raggio 8px, nessuna ombra, in fondo alla colonna di
  lettura. Le intestazioni (Da, A, Cc, Oggetto) sono righe 32px separate
  da filetti dentro la casella, come i campi di una scheda di catalogo;
  il corpo è testo libero 14px. Claude non ha un posto a parte: scrive
  **nel campo**, dove scrive la persona, con il suo cursore d'inchiostro.
- **Dove si apre**:
  - **Reply / Reply all / Forward**: la casella compare in fondo alla
    conversazione, sotto l'ultimo messaggio (che resta visibile sopra),
    con il fuoco nel corpo (Forward: nel campo A) e il pannello che
    scorre fino a lei. Il bottone premuto della testata resta segnato
    finché la casella è aperta. Un'intestazione 12px dentro la casella
    dice la modalità: «Reply to Monica Corsi» / «Reply to all (4)» /
    «Forward» con un menu per passare dall'una all'altra senza perdere il
    corpo **[A 1]**.
  - **New email**: il pannello di lettura diventa la casella a tutta
    altezza (nessuna conversazione sopra), con il titolo `headline` «New
    email» e «Discard» · «Close» in testa; in cima all'elenco compare una
    riga bozza «Draft · (no subject)» che si aggiorna mentre si scrive.
    Chiudere la lascia lì **[A 2]**. ⌘N in Mail, «New email» in testa alla
    colonna (primario pieno d'inchiostro, come «New task»), ⌘K «New
    email».
- **Righe della casella** (dall'alto):
  1. **From** (solo con due o più caselle collegate, altrimenti
     nascosto): menu con le mie caselle; in una risposta parte dalla
     casella che ha ricevuto il messaggio. Una casella scaduta è nel menu
     ma disattivata con «Connection expired · Reconnect».
  2. **To**: campo a gettoni (vedi «Destinatari»); a destra «Cc» (link
     che apre la riga Cc, già aperta se la risposta ne ha) **[A 3]**.
  3. **Cc** (se aperta).
  4. **Subject**: in Reply «Re: …», in Forward «Fwd: …», modificabile;
     nuova email vuoto con segnaposto «Subject».
  5. **Corpo**: cresce con il testo fino a riempire il pannello, poi
     scorre dentro; segnaposto «Write your reply…» / «Write your
     email…». Sotto il corpo, in Reply e Forward, «··· Show quoted text»
     (il messaggio originale citato, chiuso; in Forward sempre incluso,
     in Reply incluso salvo toglierlo) **[A 4]**.
  6. **Allegati**: gettoni sopra la barra (glifo del tipo, nome, peso
     tnum, ×); quelli del Drive con il codice («MKX-F12 Preventivo
     rev. 3.pdf»).
  7. **Barra**: a sinistra graffetta «Attach ▾» (Upload from your
     computer · From the MKX Drive) e **Ask Claude** (avatar CL 16px +
     parola); a destra lo stato della bozza 12px faint («Saved» /
     «Saving…»), «Discard» (quieto, cestino) e **Send** (primario pieno
     d'inchiostro, ⌘Enter nel `title`).
- **Momento focale**: il corpo che si riempie dalla bozza di Claude, con il
  cursore d'inchiostro in coda e **Stop** al posto di «Ask Claude».

```
┌ reading pane ─────────────────────────────────────────────────────┐
│ (MC) Monica Corsi · ordini@mixcucine.example        Yesterday 10:42│
│ Ciao Giulia, ci servirebbe il preventivo rivisto entro giovedì…   │
│ ┌ Reply to Monica Corsi ▾ ─────────────────────────────────────┐  │
│ │ To   (MC) Monica Corsi ×  [type a name or address]       Cc  │  │
│ │ Subject  Re: Revised quote for the spring campaign           │  │
│ │ ──────────────────────────────────────────────────────────── │  │
│ │ Ciao Monica, ti confermo che il preventivo rivisto arriva    │  │
│ │ giovedì 29: stiamo chiudendo l'ultimo punto sui banner▌      │  │
│ │ ··· Show quoted text                                         │  │
│ │ ┌ What should it say? (optional) ─────────────────────────┐  │  │
│ │ │ digli che arriva giovedì                                 │  │  │
│ │ └──────────────────────────────────────────────────────────┘  │  │
│ │ [📎 MKX-F12 Preventivo rev. 3.pdf · 240 KB ×]                │  │
│ │ [Attach ▾] [■ Stop]                 Saved   Discard  [Send]  │  │
│ └──────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

## 4. Ambito e confini

- Dentro: le quattro modalità, mittente, destinatari, Cc, oggetto, corpo,
  testo citato, allegati (disco e Drive), «Ask Claude», bozze, invio con
  «Undo», stati dell'invio nella conversazione, «Retry».
- Fuori: Ccn, firme, formattazione ricca (grassetto, elenchi, link
  visibili come bottoni), invio programmato, modelli, conferme di lettura,
  etichette, archiviazione **[A 5]**. Il corpo è testo semplice; un URL
  incollato resta testo e diventa link per chi riceve.
- **Anti-obiettivi**: un'email che parte senza «Send» (anche da un
  tasto rapido dentro la bozza di Claude); una bozza di Claude che
  sovrascrive in silenzio quello che la persona aveva scritto; un
  suggerimento di destinatario che rivela un indirizzo visto solo nella
  posta di un collega; un «Undo» che lascia una traccia nella
  conversazione; una finestra di composizione flottante che copre la
  conversazione a cui si risponde.

## 5. Stati e intervalli

- **Destinatari**: 0–40+ per campo. Ogni destinatario è un gettone 24px
  (persona del team: avatar 16px + nome, indirizzo nel `title`; esterno:
  l'indirizzo, o nome se noto dalla posta). Indirizzo non valido: gettone
  con contorno e icona in `critical` + «Not a valid address» nel `title`
  e sotto il campo. Oltre 6 gettoni, a campo non a fuoco: «Monica Corsi,
  Marco Bellini and 38 others» su una riga; a fuoco si aprono tutti, a
  capo, fino a 4 righe poi scorre **[A 6]**. Lo stesso indirizzo due volte
  si unisce in un gettone.
- **Completamento**: scrivendo, sotto il campo si apre un menu flottante
  320px (ombra dei flottanti, `rule-strong`) con due gruppi: TEAM (avatar,
  nome, indirizzo, reparto — le persone del team con l'indirizzo noto) e
  FROM YOUR MAIL (nome + indirizzo visti nei messaggi che vedo, i più
  recenti prima); 8 righe al massimo. ↑/↓ muovono, Enter o Tab scelgono,
  Esc chiude. Virgola, punto e virgola, Enter o Tab dopo un indirizzo
  scritto lo trasformano in gettone; incollare un elenco separato da
  virgole, punti e virgola o righe crea più gettoni. Backspace su campo
  vuoto seleziona l'ultimo gettone, un secondo Backspace lo toglie.
- **Allegati**: 0–10 file **[A 7]**; totale fino a 25 MB (il limite di
  Gmail): oltre, il gettone che sfora resta con icona + «Too large: Gmail
  accepts up to 25 MB per email» in `critical` e **Send** è disattivato
  con la ragione nel `title`. Caricamento dal disco: gettone con barra
  sottile d'avanzamento (nel prototipo legge solo nome, tipo e peso).
  Trascinare file sulla casella mostra il velo «Drop to attach».
- **Dal Drive del progetto**: apre il selettore dei file del Drive del
  progetto della conversazione (lo stesso `Picker` di «Add from Google
  Drive», area 5), solo file che vedo (`canSeeDriveFile`), ricerca e
  selezione multipla; con più progetti nella conversazione, un menu in
  testa per scegliere; nuova email o conversazione senza progetto: il
  menu parte da «Choose a project» con i progetti di cui vedo il Drive.
  Sotto la selezione, una riga 12px: «Recipients get a copy of the file.
  Stubwise doesn't share the Drive with them.» **[A 8]**. Un file Google
  del Drive si allega come link Google, con la riga «Recipients need
  access on Google to open it.»
- **Forward**: gli allegati originali entrano come gettoni, rimovibili.
- **«Ask Claude»**:
  1. Clic (o ⌘J **[A 9]**): sopra la barra si apre una riga «What should
     it say? (optional)» con segnaposto «e.g. tell them it slips to
     Thursday» e **Write draft**; Enter scrive, Esc chiude la riga. In
     una nuova email senza conversazione l'indicazione è obbligatoria e il
     progetto si sceglie lì accanto («About: MKX ▾», facoltativo).
  2. Se il corpo ha già del testo mio, prima di scrivere: «Replace your
     text or add Claude's draft below it?» · «Add below» · **Replace**
     **[A 10]**.
  3. **Streaming**: il testo cresce nel corpo con il cursore d'inchiostro
     in coda (fermo con movimento ridotto); il corpo è in sola lettura
     finché scrive; «Ask Claude» diventa **Stop** (⌘.); **Send** è
     disattivato. Stop tiene il testo fin lì e rende il campo modificabile.
  4. **Fine**: sotto il corpo, riga 12px `ink-muted` con avatar CL: «Draft
     by Claude from this conversation and MKX · edit it before sending» +
     «Used: MKX-91 Banner review (late), MKX-96 Send the revised quote»
     (citazioni con codice e nome, solo cose che vedo) + «Undo» (rimette
     il corpo com'era prima) + «Try again» (riapre l'indicazione). La riga
     resta finché si modifica il corpo, poi diventa solo «Edited from
     Claude's draft» **[A 11]**.
  5. **Errore**: icona + «Claude couldn't write a draft. Your text is
     unchanged.» + «Try again».
- **Bozze**: salvataggio automatico 800ms dopo l'ultima modifica, su
  chiusura della casella e su cambio di conversazione; stato «Saving…» →
  «Saved». **Una bozza per conversazione** (cambiare tra Reply / Reply all
  / Forward la conserva, aggiornando destinatari e oggetto) **[A 1]**.
  Riaprendo la conversazione con una bozza, la casella è già aperta in
  fondo con il testo, il fuoco **non** ci salta dentro. In elenco la riga
  della conversazione porta «Draft» con la matita (`mail.md`). «Discard»
  toglie la bozza senza conferma e mostra l'avviso «Draft discarded ·
  Undo» per 5 s. Esc chiude la casella e tiene la bozza.
- **Prima dell'invio** (controlli in linea, sopra la barra, mai dialoghi):
  nessun destinatario → **Send** disattivato con «Add at least one
  recipient» nel `title`; oggetto vuoto → al primo «Send» la riga «Send
  without a subject?» · «Add subject» · **Send anyway**; casella mittente
  scaduta → «You can't send from laura.costa@… until you reconnect» +
  **Reconnect**, Send disattivato.
- **Invio** **[A 12]**:
  1. «Send» (⌘Enter): la casella si chiude; il messaggio compare **in
     fondo alla conversazione** come un messaggio mio in `ink-muted` con
     l'anello e «Sending…»; avviso in basso «Sending to Monica Corsi ·
     Undo» per 5 s (la `Toast` esistente, che dura già 5 s per gli
     avvisi), con ⌘Z come scorciatoia mentre è visibile.
  2. «Undo» entro 5 s: il messaggio sparisce dalla conversazione, la
     casella si riapre con **tutto** com'era (destinatari, oggetto, corpo,
     allegati, modalità), il fuoco nel corpo; nessuna riga «annullato»
     nella conversazione.
  3. Dopo 5 s: «Sent» 12px per 3 s sotto il messaggio, poi messaggio
     normale. Una nuova email inviata diventa una conversazione in cima
     all'elenco e si apre.
  4. **Fallito**: il messaggio resta in fondo con icona + «Not sent:
     address not found (luca@bounce.example)» in `critical` e i comandi
     **Retry** · «Edit» (riapre la casella con il testo intatto) ·
     «Delete» (toglie il tentativo, la bozza resta). Mai un nuovo
     tentativo da solo.
  5. Un «Undo» arrivato tardi (oltre la finestra): «Too late to undo:
     the email was sent.»
- **Cambio di persona** («vedi come») con una casella aperta o durante i
  5 s: la casella si chiude salvando la bozza **della persona di prima**;
  l'invio in corso resta suo e si conclude a suo nome; l'avviso «Undo»
  sparisce; la persona nuova non vede né la bozza né il messaggio, salvo
  che ne sia destinataria (allora lo vede come arrivato, dopo i 5 s).
- **Errori**: salvataggio della bozza non riuscito: «Couldn't save the
  draft · Retry» 12px `critical` nella barra (il testo resta nel campo).

## 6. Interazione e layout

- **Larghezza**: la casella segue la colonna di lettura (fino a 760px); in
  una finestra stretta (elenco e pannello uno per volta, `mail.md`) prende
  tutta l'area con «← Back to the conversation».
- **Tastiera**:
  - da elenco o pannello (fuoco fuori dai campi): R Reply · A Reply all ·
    F Forward; ⌘N New email;
  - nella casella: ⌘Enter **Send**; ⌘J **Ask Claude**; ⌘. **Stop**;
    ⌘⇧C apre o chiude Cc; ⌘⇧A Attach **[A 9]**; Esc chiude la casella
    (bozza salvata) o, se aperti, prima il menu dei destinatari o la riga
    dell'indicazione; ⌘Z durante i 5 s dell'avviso = Undo send.
  - Tab segue l'ordine visivo: From, To, Cc, Subject, corpo, allegati,
    barra.
- **Fuoco e ritorno**: chiusa la casella, il fuoco torna al bottone che
  l'aveva aperta (Reply, Reply all, Forward, New email); dopo l'invio, al
  messaggio inviato.
- **Movimento**: casella che entra in fondo 200ms (dissolvenza + 8px dal
  basso); messaggio inviato che passa da «Sending…» a normale senza
  movimento; nulla con movimento ridotto (anche il cursore dello
  streaming resta fermo).

## 7. Accessibilità

- Campi destinatari come `combobox` con `listbox` dei suggerimenti; ogni
  gettone ha un nome accessibile («Monica Corsi, ordini@mixcucine.example,
  remove with Backspace») e il conteggio compresso è letto per intero.
- Lo streaming della bozza **non** è annunciato frammento per frammento:
  `aria-busy` sul corpo mentre scrive, poi un annuncio `polite` «Claude's
  draft is ready».
- L'avviso «Undo» è in `aria-live="polite"` e «Undo» è raggiungibile da
  tastiera finché c'è; «Not sent» è annunciato `assertive`.
- Stati («Saving…», «Sending…», «Not sent», limiti superati) sempre in
  parole, mai solo icona o colore.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| modalità | Reply · Reply all · Forward · New email · Reply to {{name}} · Reply to all ({{count}}) | Rispondi · Rispondi a tutti · Inoltra · Nuova email · Rispondi a {{name}} · Rispondi a tutti ({{count}}) |
| campi | From · To · Cc · Subject · Write your reply… · Write your email… · Show quoted text · and {{count}} others | Da · A · Cc · Oggetto · Scrivi la risposta… · Scrivi l'email… · Mostra il testo citato · e altri {{count}} |
| destinatari | Team · From your mail · Not a valid address · Add at least one recipient | Team · Dalla tua posta · Indirizzo non valido · Aggiungi almeno un destinatario |
| allegati | Attach · Upload from your computer · From the {{code}} Drive · Choose a project · Drop to attach · Too large: Gmail accepts up to 25 MB per email · Recipients get a copy of the file. Stubwise doesn't share the Drive with them. · Recipients need access on Google to open it. | Allega · Carica dal computer · Dal Drive di {{code}} · Scegli un progetto · Rilascia per allegare · Troppo grande: Gmail accetta fino a 25 MB per email · I destinatari ricevono una copia del file. Stubwise non condivide il Drive con loro. · Per aprirlo i destinatari devono avere accesso su Google. |
| claude | Ask Claude · What should it say? (optional) · e.g. tell them it slips to Thursday · Write draft · Stop · Replace your text or add Claude's draft below it? · Add below · Replace · Draft by Claude from this conversation and {{code}} · edit it before sending · Used: · Edited from Claude's draft · Claude couldn't write a draft. Your text is unchanged. · Try again · Undo | Chiedi a Claude · Cosa deve dire? (facoltativo) · es. digli che slitta a giovedì · Scrivi la bozza · Ferma · Sostituire il tuo testo o aggiungere sotto la bozza di Claude? · Aggiungi sotto · Sostituisci · Bozza di Claude da questa conversazione e da {{code}} · modificala prima di inviare · Usati: · Modificata dalla bozza di Claude · Claude non è riuscito a scrivere una bozza. Il tuo testo non è cambiato. · Riprova · Annulla |
| bozze | Saving… · Saved · Couldn't save the draft · Discard · Draft discarded · Undo · Draft | Salvataggio… · Salvata · Non è stato possibile salvare la bozza · Elimina · Bozza eliminata · Annulla · Bozza |
| controlli | Send without a subject? · Add subject · Send anyway · You can't send from {{email}} until you reconnect · Reconnect | Inviare senza oggetto? · Aggiungi l'oggetto · Invia comunque · Non puoi scrivere da {{email}} finché non ricolleghi l'account · Ricollega |
| invio | Send · Sending… · Sending to {{names}} · Undo · Sent · Not sent: {{reason}} · Retry · Edit · Delete · Too late to undo: the email was sent. | Invia · Invio in corso… · Invio a {{names}} · Annulla · Inviata · Non inviata: {{reason}} · Riprova · Modifica · Elimina · Troppo tardi per annullare: l'email è partita. |

## 9. Vincoli

- **Nulla esce dall'app**: l'invio aggiorna lo store finto; la finestra di
  5 s usa il timer del prototipo (`now()`), mai `Date.now()`; il seme ha
  un indirizzo `@bounce.example` che fallisce sempre.
- La bozza di Claude è un testo finto costruito dal contesto
  (`domain/claude/intents/mailDraft.ts`), servito con lo streaming di
  `data/stream.ts`; cita solo task e progetti visibili a chi scrive; non
  chiama mai `sendDraft`.
- `suggestRecipients` e il selettore del Drive leggono solo ciò che chi
  scrive vede (`canSeeMessage`, `canSeeDriveFile`).
- Componenti riusati: la casella e il cursore della conversazione
  (`pages/claude/conversation/Composer.tsx`, `useComposerField`), il
  `Picker` del Drive, `AttachmentChip`, la `Toast` con azione; le bozze
  come quelle della Chat (`pages/chat/drafts.ts`), per persona e
  conversazione.
- Nessun permesso nuovo: scrivere richiede solo una casella collegata e
  non scaduta.

## Scelte del brief da confermare

Ogni voce è una **[scelta del brief]**, non scritta nello spec.

1. Una sola bozza per conversazione: passare fra Reply, Reply all e
   Forward la conserva (cambiano destinatari e oggetto, non il corpo).
2. «New email» usa il pannello di lettura (`#/mail?compose=new`, un
   parametro in più rispetto al piano; nessuna finestra flottante) e
   lascia in elenco una riga «Draft» finché non si invia o elimina.
3. Cc è nascosto finché non serve (aperto da sé quando la risposta ne
   ha); niente Ccn.
4. In Reply il messaggio originale è citato sotto, chiuso, e si può
   togliere; in Forward è sempre incluso.
5. Corpo in testo semplice: niente formattazione ricca, firme, invio
   programmato, modelli.
6. Oltre 6 destinatari il campo si comprime a «X, Y and N others» quando
   non è a fuoco.
7. Fino a 10 allegati e 25 MB in tutto (limite di Gmail).
8. Un file del Drive di Stubwise si allega come copia; un file Google
   come link Google, con una riga che dice cosa riceverà il destinatario.
9. Scorciatoie: ⌘Enter Send, ⌘J Ask Claude, ⌘. Stop, ⌘⇧C Cc, ⌘⇧A Attach,
   ⌘Z durante l'avviso = Undo send; R/A/F/⌘N come in `mail.md`.
10. Se il corpo ha già testo, Claude chiede «Replace» o «Add below» prima
    di scrivere; non sovrascrive mai in silenzio.
11. Finita la bozza, una riga dice da cosa l'ha scritta Claude, con le task
    citate («Used: …»), «Undo» e «Try again»; diventa «Edited from
    Claude's draft» dopo una modifica.
12. Durante i 5 s il messaggio è già nella conversazione come «Sending…»
    (solo per chi scrive) e l'avviso offre «Undo»; annullato, sparisce
    senza traccia e la casella torna com'era.
