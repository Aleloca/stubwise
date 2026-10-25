# Shape brief — Google Drive nel Drive

Superficie: account Google personale (dal menu profilo, «Google account»),
collegare e scollegare una cartella Google a un progetto (con l'avviso di
leggibilità), «Add from Google Drive» (selettore di file), «Which
project?» dopo l'apertura di un file Google fuori dai progetti, file non
disponibile, collegamento della cartella scaduto, nascondere/rimostrare e
filtro «Hidden», storico delle aperture (`drive.history`). Piano: Task 7
(più i pezzi di Task 5 che decidono). Spec: area 5 «Come un file Google
entra nel progetto», «Casi limite», «Aperture», «Permessi», «Quanto è vero
nel prototipo». Mondo: «Catalogo numerato», modalità **Operate**.
Elenco e dettaglio sono di `drive.md`; la ricerca di `drive-search.md`.
**[A n]** = assunzione numerata in fondo.

## 1. Lavoro e pubblico

- **Chi collega una cartella**: il Project Lead (`drive.manage`), di solito
  all'avvio di una commessa: «la cartella del cliente sta su Google, voglio
  che il progetto la veda». Deve capire **prima** di collegare che tutti i
  membri del progetto ne leggeranno il contenuto, anche chi su Google non
  ha accesso.
- **Chi aggiunge un file singolo** (`drive.upload`): «questo preventivo
  sta nel mio Drive personale, serve qui».
- **Chi cerca e trova un file Google fuori dai progetti**: lo apre per
  leggerlo, e Stubwise gli chiede se va in un progetto — senza bloccarlo.
- **Chi controlla l'uso** (`drive.history`, Project Lead): vuole sapere se
  il **team** ha aperto la versione giusta del contratto prima della
  riunione; lo storico è uno strumento di lavoro, non di sorveglianza (chi
  apre direttamente su Google non lo sappiamo).

## 2. Esito e prova

- Azione primaria: collegare una cartella o un file in pochi secondi,
  sapendo cosa succede alla visibilità.
- Successo: il dialogo di collegamento dice in una frase chi leggerà cosa e
  con quale account; un file non disponibile dice perché e cosa si può
  fare; un collegamento scaduto lo vede subito chi può ripararlo, e solo
  lui riceve l'invito ad agire; «Which project?» non è mai un muro: «Not
  now» apre comunque.
- Verità del prodotto: Stubwise legge la cartella con l'account di chi
  l'ha collegata; un file di cartella non si toglie, si **nasconde**
  (reversibile, la sincronizzazione non lo rimette); i file di cartella
  risultano aggiunti da chi ha collegato; un file Google in due progetti
  è due riferimenti; un'apertura da Google fuori da Stubwise non la
  sappiamo.

## 3. Direzione scelta

- **Tesi**: Google è un **fornitore esterno** del catalogo. Ogni punto in
  cui Stubwise agisce con l'account Google di qualcuno lo dice per nome
  («with matteo.conti@… »), e ogni conseguenza sulla visibilità è scritta
  sotto il bottone che la provoca, non in un aiuto a parte. Dialoghi
  brevi, una decisione per volta, come i dialoghi della Chat.
- **Account Google** (menu profilo → «Google account», dialogo 480px)
  **[A 1]**: tre stati.
  - Non collegato: «Connect your Google account so Stubwise can find your
    Google Drive files and link folders to projects.» + **Connect Google
    account** (simulato: diventa collegato con l'email finta della
    persona) + nota 12px «Mail and Calendar will use the same account.»
  - Collegato: «Connected as matteo.conti@example.com» · «Since Oct 2» +
    «Disconnect». Disconnettere chiede conferma con la conseguenza
    contata: «2 folders you linked will stop updating: AUD – Cliente,
    MKX – Grafica. Their files will show as not available until someone
    links them again.» · **Disconnect**.
  - Scaduto: icona + «Your Google connection expired on Oct 20» +
    **Reconnect**.
- **Collegare una cartella** (`drive.manage`; dal «⋯» della testata del
  Drive «Link a Google folder», dallo stato vuoto, da ⌘K «Link a Google
  folder to AUD»), dialogo 560px:
  1. Senza account collegato: il dialogo apre al passo «Connect your Google
     account first» con il bottone, poi prosegue.
  2. **Scegli la cartella**: selettore con briciole («My Drive › Clienti ›
     Audin»), campo di ricerca, elenco 36px di cartelle (glifo + nome +
     «38 files» faint) **[A 2]**; doppio clic entra, clic seleziona; le
     cartelle già collegate a questo progetto sono disattivate con
     «Already linked».
  3. **Avviso** (sempre visibile sotto la selezione, non un passo a sé):
     «Everyone in AUD (14 people) will be able to read every file in
     “AUD – Cliente” and its subfolders, even people who can't open it on
     Google. Stubwise reads it with your account, matteo.conti@….»
  4. «Cancel» · **Link folder**. Dopo: avviso «Linked AUD – Cliente ·
     Reading 14 files…»; il gruppo compare in testa al Drive con i file in
     «Reading the content…».
- **Scollegare**: «⋯» del gruppo → «Unlink folder» → dialogo «Unlink
  “AUD – Cliente” from AUD? Its 14 files leave AUD, with their opens.
  Nothing changes on Google. Files uploaded to AUD stay.» · **Unlink**
  **[A 3]**. Altre voci del «⋯»: «Open in Google Drive», «Sync now»
  **[A 4]**, «Copy link».
- **Add from Google Drive** (`drive.upload`): dialogo 640px con lo stesso
  selettore ma di file (tipo, nome, proprietario, modifica), selezione
  multipla con caselle, campo di ricerca; file già in questo progetto
  disattivati «Already in AUD». **Add 3 files**. Nessun avviso di
  visibilità di cartella, ma una riga sotto: «Everyone in AUD will be able
  to read these files.» Senza account: passo «Connect your Google account
  first».
- **«Which project?»** (dopo l'apertura di un file Google fuori dai
  progetti, da ⌘K o dalla ricerca del Drive): il file si apre (avviso
  «Opened in Google Drive»), poi un dialogo 440px: titolo «Add
  “Contratto quadro …” to a project?», elenco dei soli progetti dove ho
  `drive.upload` (fissati prima, poi alfabetico; codice tnum + nome;
  campo di ricerca sopra 8 righe), riga d'avviso «Everyone in the project
  will be able to read it.», «Not now» · **Add to project**. Senza
  progetti idonei il dialogo non compare: solo l'avviso «Opened in Google
  Drive» **[A 5]**. Dopo: «Added to AUD as AUD-F33 · Open».
- **Non disponibile**: nella riga (`drive.md`) e nel dettaglio, al posto
  dell'anteprima, una fascia con icona + causa in parole:
  «Deleted on Google» / «Stubwise lost access: the folder was unlinked or
  shared differently on Google» / «Stubwise lost access: Matteo Conti's
  Google account was disconnected». Azione: «Remove from project» (chi
  l'ha aggiunto o `drive.manage`); per i file di cartella con account
  scaduto, a chi può: «Reconnect». Conteggi ancora visibili; contenuto non
  più cercabile (solo per nome).
- **Collegamento della cartella scaduto**: a chi ha `drive.manage`, fascia
  in testa al Drive del progetto, filetto sinistro `warning` + icona:
  «The link to “AUD – Cliente” expired on Oct 20. Its files show what
  Stubwise read until then and don't update.» + **Reconnect** (se il
  collegamento è suo) o «Ask Matteo Conti to reconnect» (se è di un
  altro: apre un DM precompilato) **[A 6]**. Agli altri membri: niente
  fascia; il gruppo dice «Not updating since Oct 20» in `ink-faint`.
- **Nascondere** (`drive.manage`, solo file di cartella): «Hide from
  project» nel dettaglio e nel «⋯» della riga. Nessuna conferma: la riga
  esce con avviso «Hidden AUD-F8 · Undo» (5 s) **[A 7]**. Filtro
  **Hidden** (gettone, solo per `drive.manage`, con conteggio): mostra solo
  i nascosti, riga in `ink-faint` con «Hidden by Laura Costa · Oct 19» e
  «Show again». Rimostrato torna col suo codice e il suo conteggio.
  Per i non-gestori un file nascosto non esiste (né in elenco, né in
  ricerca, né per codice).
- **Storico delle aperture** (`drive.history`): sezione WHO OPENED IT nel
  dettaglio, sotto OPENS. Righe 32px: avatar 20px + nome · modo (glifo +
  parola: Preview / Google Drive / Download) · data e ora tnum; più
  recenti in alto, 10 + «Show all 61» (elenco completo nel pannello,
  paginato). Nota 12px faint: «Repeat opens by the same person within 30
  minutes count once. Visible to people who manage this project's
  Drive.» Nessun totale per persona, nessuna classifica, nessuna
  esportazione **[A 8]**. Senza permesso la sezione non c'è (nemmeno un
  segnaposto).
- **Momento focale**: la frase di visibilità nel dialogo di collegamento,
  in 14px ink sopra il bottone, con il numero delle persone.

```
┌ Link a Google folder to AUD ────────────────────────────┐
│ My Drive › Clienti                          ⌕ Search    │
│ ▭ Audin                                    38 files     │
│ ▭ AUD – Cliente                    ●       14 files     │
│ ▭ Archivio 2024                            Already linked│
│ ─────────────────────────────────────────────────────── │
│ Everyone in AUD (14 people) will be able to read every  │
│ file in “AUD – Cliente” and its subfolders, even people │
│ who can't open it on Google. Stubwise reads it with     │
│ your account, matteo.conti@example.com.                 │
│                                   Cancel  [Link folder] │
└─────────────────────────────────────────────────────────┘
```

## 4. Ambito e confini

- Dentro: account (stato, collega/scollega/ricollega), cartelle (collega,
  scollega, sincronizza, scaduto), file singoli (aggiungi, togli), «Which
  project?», non disponibile, nascosti, storico.
- Fuori: il cassetto Google comune a Posta e Calendario (area 6, decisione
  aperta); Mail e Calendar; permessi Google reali, OAuth reale; condividere
  verso Google.
- **Anti-obiettivi**: un collegamento che non dice chi leggerà; una
  domanda «Which project?» che blocca l'apertura; un pannello «Activity»
  con chi ha aperto cosa visibile a tutti; un «elimina» su un file di
  cartella che lasci credere di cancellarlo da Google; un avviso di
  scadenza mostrato a chi non può farci niente.

## 5. Stati e intervalli

- Account: non collegato · collegato · scaduto · in collegamento
  (simulato, 1 s) · errore «Couldn't connect to Google» + «Try again».
- Cartelle: 0–5 per progetto; 1–200 file; in sincronizzazione (gruppo con
  «Reading 14 files…»); ok; scaduta; scollegata (sparisce).
- Selettori: caricamento (6 righe scheletro), vuoto «This folder is
  empty», nessun risultato «No folders match “cliente”», errore «Couldn't
  reach Google Drive» + «Retry».
- «Which project?»: con 1 progetto idoneo il dialogo lo preseleziona; con
  0 non compare; con 30+ si cerca.
- Storico: 0 aperture «Nobody has opened it yet»; migliaia, paginato.
- **Cambio di persona**: dialoghi aperti (collega, aggiungi, «Which
  project?», account) si chiudono senza effetti; lo storico sparisce se la
  persona nuova non ha `drive.history`; nessuna email dell'account della
  persona di prima resta a schermo.

## 6. Interazione e layout

- Dialoghi sopra la finestra con `scrim`, raggio 12px, `rule-strong`,
  ombra dei flottanti; fuoco sul primo campo utile; ritorno del fuoco
  all'origine.
- Selettori: ↑/↓ muovono, Enter entra nella cartella (o seleziona un
  file), ⌫ torna su di un livello, Space spunta un file, ⌘Enter conferma.
- 1024×680: dialoghi invariati (stanno in 720px); la fascia di scadenza va
  a capo in due righe con il bottone sotto.
- Movimento: dialoghi 200ms (scala 0.98 → 1 + dissolvenza), riga nascosta
  che esce in 150ms; nulla con movimento ridotto.

## 7. Accessibilità

- Il testo di visibilità è collegato al bottone con `aria-describedby`,
  così lo legge anche chi va diretto al bottone.
- Stato dell'account e cause di «non disponibile» in parole; `warning` e
  `critical` sempre con icona e testo.
- Selettore di cartelle `listbox` (singola), di file `listbox`
  multiselezione con `aria-selected`; briciole come `nav`.
- Avvisi (collegato, nascosto + Undo, aggiunto) in `aria-live="polite"`;
  Undo raggiungibile da tastiera finché l'avviso c'è.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| account | Google account · Connect Google account · Connected as {{email}} · Disconnect · Reconnect | Account Google · Collega l'account Google · Collegato come {{email}} · Scollega · Ricollega |
| scaduto | Your Google connection expired on {{date}} | Il collegamento con Google è scaduto il {{date}} |
| collega | Link a Google folder · Link folder · Already linked | Collega una cartella Google · Collega la cartella · Già collegata |
| avviso | Everyone in {{code}} ({{count}} people) will be able to read every file in “{{folder}}” and its subfolders, even people who can't open it on Google. Stubwise reads it with your account, {{email}}. | Tutti i membri di {{code}} ({{count}} persone) potranno leggere ogni file di «{{folder}}» e delle sue sottocartelle, anche chi su Google non può aprirla. Stubwise la legge con il tuo account, {{email}}. |
| scollega | Unlink “{{folder}}” from {{code}}? Its {{count}} files leave {{code}}. Nothing changes on Google. | Scollegare «{{folder}}» da {{code}}? I suoi {{count}} file escono da {{code}}. Su Google non cambia nulla. |
| aggiungi | Add from Google Drive · Add {{count}} files · Already in {{code}} | Aggiungi da Google Drive · Aggiungi {{count}} file · Già in {{code}} |
| progetto | Add “{{name}}” to a project? · Not now · Add to project | Aggiungere «{{name}}» a un progetto? · Non ora · Aggiungi al progetto |
| non disp. | Not available · Deleted on Google · Stubwise lost access · Remove from project | Non disponibile · Eliminato su Google · Stubwise ha perso l'accesso · Togli dal progetto |
| scadenza | The link to “{{folder}}” expired on {{date}}. · Ask {{name}} to reconnect | Il collegamento a «{{folder}}» è scaduto il {{date}}. · Chiedi a {{name}} di ricollegarla |
| nascosti | Hide from project · Hidden {{code}} · Undo · Show again · Hidden by {{name}} · {{date}} | Nascondi dal progetto · {{code}} nascosto · Annulla · Mostra di nuovo · Nascosto da {{name}} · {{date}} |
| storico | Who opened it · Preview · Google Drive · Download · Nobody has opened it yet | Chi l'ha aperto · Anteprima · Google Drive · Download · Nessuno l'ha ancora aperto |

## 9. Vincoli

- Google interamente simulato nei dati finti; «Open in Google Drive» non
  apre il browser (avviso + apertura contata).
- Permessi: collega/scollega/nascondi/riprova = `drive.manage`; aggiungi
  file singolo = `drive.upload`; togli = chi l'ha aggiunto o
  `drive.manage`; storico = `drive.history`. Le azioni non permesse non
  compaiono (nessun bottone spento senza spiegazione).
- Tutto ciò che dipende dalla persona (account, storico, dialogo in
  sospeso) si azzera al cambio di persona (Review Focus 3).

## Assunzioni da confermare

1. L'account Google personale si gestisce da un dialogo aperto dal menu
   profilo («Google account»), finché non esiste una pagina Impostazioni →
   Account del desktop; la nota dice che Posta e Calendario useranno lo
   stesso account (area 6 decide il cassetto comune).
2. Il selettore di cartelle è un navigatore simulato con briciole e
   ricerca, dentro Stubwise (non il selettore Google in finestra a parte).
3. Scollegare una cartella si conferma con un dialogo che conta i file che
   escono; i conteggi delle aperture di quei riferimenti si perdono (se la
   si ricollega i file ripartono da zero).
4. Il «⋯» di una cartella offre anche «Sync now» (nel prototipo rilancia il
   ritardo simulato e mostra il file «aggiornato su Google»).
5. Senza progetti con `drive.upload`, «Which project?» non compare: il file
   si apre e basta.
6. La fascia di collegamento scaduto la vede solo chi ha `drive.manage`;
   se la cartella l'ha collegata un altro, l'azione è «Ask {{name}} to
   reconnect» (DM precompilato), perché ricollegare con il proprio account
   cambierebbe chi legge.
7. Nascondere non chiede conferma: avviso con «Undo» per 5 s; la riga
   nascosta esiste solo nel filtro «Hidden» dei gestori.
8. Storico: righe per apertura (persona, modo, data), 10 visibili + «Show
   all»; nessun totale per persona, nessuna esportazione; la nota spiega la
   regola dei 30 minuti e chi lo vede.
9. Disconnettere il proprio account Google rende «non disponibili» i file
   delle cartelle collegate da me, finché qualcuno non le ricollega.
10. «Add from Google Drive» mostra solo i file che il mio account vede, già
    marcati «Already in AUD» se il progetto li ha; aggiungerne uno già
    presente in un **altro** progetto crea un riferimento nuovo con un
    codice nuovo.
