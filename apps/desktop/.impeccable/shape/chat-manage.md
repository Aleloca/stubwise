# Shape brief — Gestione dei canali e messaggi diretti

Superficie: `NewChannelDialog`, `ChannelSettings`, `NewDmDialog`, «Browse
channels» e la pagina del canale privato vista da chi gestisce senza
esserne membro. Piano: Task 6. Spec: area 4 «Canali», «Permessi»,
«Privacy». Mondo: «Catalogo numerato», modalità **Operate**.
**[ASSUNZIONE]** = da confermare.

## 1. Lavoro e pubblico

- Chiunque abbia `chat.channels.create` in un progetto (Project Lead,
  Developer) o `chat.general.create` (tutti): crea un canale in pochi
  secondi, come in Slack.
- Chi gestisce (`chat.channels.manage` nel progetto, `chat.general.manage`
  d'istanza; il creatore per il proprio canale): rinomina, sceglie gli
  eventi, invita e toglie, archivia, elimina.
- Ognuno: apre un DM o un gruppo, regola le notifiche di un canale, entra
  ed esce dai canali aperti.

## 2. Esito e prova

- Azione primaria: creare un canale o un DM e trovarcisi dentro; per chi
  gestisce, decidere cosa il canale pubblica e chi c'è.
- Successo: prima di creare si sa **dove** nasce il canale e **chi** lo
  vedrà; chi gestisce un privato senza esserne membro vede che esiste e
  chi c'è, e capisce subito perché non ne legge i messaggi.
- Verità del prodotto: i messaggi di un privato li leggono solo i membri,
  nemmeno il full admin; i DM non esistono per chi non partecipa.

## 3. Direzione scelta

- **Tesi**: dialoghi brevi per creare (una decisione alla volta, con la
  conseguenza scritta sotto ogni scelta), pannello a destra per le
  impostazioni (il canale resta visibile accanto), una pagina normale con
  h1 per il privato non leggibile. Nessuna scheda decorativa: sezioni con
  `heading-group` e filetti, come il dettaglio della task.
- **Nuovo canale** (dialogo 480px, da «+» accanto a CHANNELS, dal menu del
  sottogruppo di progetto — già scelto —, da ⌘K «New channel»):
  1. **Where**: menu «Project» con i soli progetti dove ho
     `chat.channels.create` (codice + nome) e, se ho `chat.general.create`,
     la voce «Company-wide» in testa.
  2. **Name**: minuscole, numeri, trattini, ≤ 40 caratteri; spazi diventano
     trattini mentre scrivi; anteprima sotto «Will appear as AUD ·
     price-list». Errore in riga «AUD already has a channel with this
     name».
  3. **Description** (facoltativa, una riga).
  4. **Visibility**: due righe radio — «Open · Anyone who can see AUD can
     find and join it» / «Private · Only people you invite can see it and
     read it». Nei generali «everyone in the company».
  5. Privato: **Add members** (selettore persone; in un progetto solo i
     suoi membri, gli altri non compaiono e una riga lo spiega).
  Bottoni «Cancel» · **Create channel**; si arriva nel canale nuovo, con il
  messaggio iniziale «This is the start of …».

```
┌ New channel ─────────────────────────────────┐
│ Where      [ AUD Audin 2.0              ▾ ]  │
│ Name       [ price-list                   ]  │
│            Will appear as AUD · price-list   │
│ Description[ Supplier price list updates  ]  │
│ Visibility (•) Open                           │
│                Anyone who can see AUD can     │
│                find and join it               │
│            ( ) Private                        │
│                Only people you invite can     │
│                see it and read it             │
│                        [Cancel] [Create channel]│
└──────────────────────────────────────────────┘
```

- **Impostazioni del canale** (pannello 400px, stesso slot del thread, da
  «⋯ › Settings» o dal nome canale in testata): testata «AUD · releases»
  + ×; sezioni:
  - **ABOUT**: Name, Description, Topic — campi sul posto (clic, Enter
    salva, Esc annulla). Nome e descrizione: creatore e chi gestisce;
    **Topic: qualunque membro**, come in Slack **[ASSUNZIONE]**. «Created
    by Marco Bellini on Oct 3». Visibilità in parole, non modificabile
    dopo la creazione **[ASSUNZIONE]**.
  - **NOTIFICATIONS** (personale): radio «All messages» / «Mentions only»
    / «Muted · mentions still reach you».
  - **PUBLISHED EVENTS** (solo canali di progetto): sette caselle in
    ordine — Release pages, Milestones reached, Weekly brief, PRs opened,
    PRs merged, New requests, Tasks closed — predefinite le prime tre.
    Modificabili da chi gestisce; per gli altri l'elenco degli attivi in
    sola lettura. Riga in coda: «More rules live in Automations».
  - **MEMBERS** con conteggio: «Add people» (vedi sotto), righe 36px
    avatar + nome + reparto, «Remove» al passaggio per chi può. Nel
    «general» del progetto: «Everyone in AUD is in this channel», niente
    aggiunte né rimozioni.
  - In fondo, separate da un filetto: «Leave channel» (non nel general di
    progetto), poi per chi gestisce **Archive channel** e **Delete
    channel** (testo critico).

## 4. Ambito e confini

- Dentro: creazione, impostazioni, eventi pubblicati, notifiche, membri,
  invito/rimozione, entra/esci, archivia/ripristina, elimina, nuovo DM e
  gruppo, Browse channels, pagina del privato non leggibile, ⌘K «New
  channel», «New message».
- Fuori: regole «quando X, scrivi in Y» (area 7); webhook in uscita (area
  9); cambio di progetto di un canale.
- Anti-obiettivi: un admin che si aggiunge a un privato per leggerlo; un
  «Delete» a un clic; impostazioni Slack o «Invite from Slack».

## 5. Stati e intervalli

- **Archivia**: dialogo «Archive AUD · releases? · Members can still read
  it and search it. Nobody can write in it.» · **Archive**. Ripristino da
  «Unarchive» nella fascia del canale o in Settings.
- **Elimina**: dialogo «Delete AUD · releases? · All 1,248 messages are
  deleted for everyone. Links and citations to them stop opening. This
  can't be undone.» + campo «Type the channel name to confirm»
  **[ASSUNZIONE]** · **Delete channel** (critico, attivo solo col nome
  giusto).
- Il **general** di progetto non si archivia né si elimina
  **[ASSUNZIONE]**: le voci non compaiono, una riga muted lo dice.
- **Rimuovere** un membro: conferma in riga «Remove Sara Montanari? She
  won't be able to read this channel.»; rimuovere l'ultimo membro di un
  privato non è permesso **[ASSUNZIONE]**.
- **Add people** (privato: creatore o chi gestisce; aperto: qualunque
  membro **[ASSUNZIONE]**): selettore con ricerca, già membri disattivati
  con «Already in», nei privati di progetto i non membri del progetto
  assenti con la riga «Only AUD members can be added».
- **Chi gestisce non può aggiungere se stesso** a un privato in cui non è:
  la propria riga è disattivata con «Ask a member to add you»
  **[ASSUNZIONE: altrimenti «non ne legge i messaggi» sarebbe aggirabile
  con un clic]**.
- **Nuovo DM** (dialogo 480px, «New message»): campo «To:» con gettoni
  persona, ricerca per nome e reparto; contatore «3 of 7 people»
  (massimo 8 **compreso te** **[ASSUNZIONE]**); oltre: «A group message
  can have up to 8 people». Se esiste già un DM con le stesse persone, il
  bottone diventa «Open conversation». Sotto, la casella del primo
  messaggio; l'invio crea e apre. Un DM non si archivia né si elimina; un
  gruppo si lascia con «Leave conversation» **[ASSUNZIONE]**; in Settings
  di un DM solo Notifications e i partecipanti.
- **Browse channels** (pagina, h1 «Browse channels»): filtro «All /
  Project / Company / Archived», ricerca per nome; righe 44px: glifo,
  «AUD · releases», descrizione, membri, «Joined» oppure **Join**; i
  privati compaiono solo a chi è membro o li gestisce, con la parola
  «Private» e, per chi gestisce senza esserci, «Not a member».
- **Privato visto da chi gestisce, non membro** (pagina):
  h1 «AUD · leadership» con lucchetto; meta «Private · 5 members ·
  Created by Elena Moretti on Sep 12»; poi un blocco di testo (nessuna
  scheda): **«You can't read this channel's messages.»** 16px 600, sotto
  «Private channels can be read only by their members. You manage
  channels in AUD, so you can see who's in it, archive it or delete it.»;
  `heading-group` MEMBERS con le righe; azioni **Archive channel** ·
  **Delete channel**. Nessun conteggio di messaggi, nessuna data
  dell'ultimo messaggio, nessuna anteprima **[ASSUNZIONE]**.
- **Senza permessi**: niente «+» né voce ⌘K senza alcun permesso di
  creazione; in Settings i campi non modificabili sono testo semplice con
  la riga «Only the channel's creator or someone who manages channels in
  AUD can change this.».
- Errori: salvataggio fallito in riga con «Retry», il valore precedente
  torna; caricamento membri: 5 righe scheletro.

## 6. Interazione e layout

- Dialoghi: 480px, raggio 12px, `rule-strong`, velo `scrim`, fuoco sul
  primo campo, Enter crea quando valido, Esc chiude (con bozza: «Discard
  this channel?»). Pannello Settings: agganciato da 1200px, sovrapposto
  sotto; esclusivo con il thread (aprirne uno chiude l'altro).
- Il bottone primario è sempre l'ultimo a destra; le azioni distruttive
  sono testo critico, mai pieno, fino al dialogo.
- Cambiare il nome aggiorna subito colonna, testata e citazioni
  («AUD · releases» → «AUD · release-notes»); i link restano validi.
- Toast con Undo per Leave e Archive («Archived AUD · releases · Undo»),
  non per Delete.
- 1024px: dialoghi invariati; Browse perde la colonna dei membri.

## 7. Vincoli e decisioni aperte

- Permessi da `can()`/livello dati; ogni rifiuto lascia lo stato
  invariato e mostra il motivo, mai un bottone che fallisce in silenzio.
- La pagina del privato non leggibile non deve esporre nulla del
  contenuto: né conteggi né attività né citazioni dei suoi messaggi.
- I DM altrui non hanno pagina: un link diretto dà «This channel doesn't
  exist or you can't see it», anche per il full admin.
