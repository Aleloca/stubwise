# Shape brief — Drive del progetto e destinazione «Drive»

Superficie: sezione «Drive» del progetto (`#/p/<code>/drive`, sempre
presente), destinazione «Drive» sul binario (`#/drive`, file di tutti i
progetti che vedi), pannello di dettaglio `?file=<PRJ>-F<n>` (vale su ogni
rotta, come `?task=`), anteprima a tutta area, caricamento. Piano: Task
4–6. Spec: area 5 «Drive» (Cosa contiene, Codici, Organizzazione, Dove
vive, Aperture, Casi limite, Quanto è vero nel prototipo, Permessi, Stati).
Google (cartelle, account, «a quale progetto?», nascosti, storico) è in
`drive-google.md`; la ricerca in `drive-search.md`. Mondo: «Catalogo
numerato», modalità **Operate**. **[A n]** = assunzione numerata in fondo.

## 1. Lavoro e pubblico

- Tutti i reparti: il commerciale che cerca il preventivo mandato al
  cliente, il marketing che riprende i mockup della campagna, l'assistenza
  che apre il contratto per i tempi di consegna, lo sviluppatore che
  allega le specifiche. Ci passano più volte al giorno e quasi sempre
  cercano **gli stessi pochi file**.
- Tre fatiche dichiarate dal maintainer: il nome del file non lo ricorda
  nessuno; i file usati si perdono fra gli altri; il team resta su Google
  Drive. Il Drive non sostituisce Google: lo **raggiunge**.

## 2. Esito e prova

- Azione primaria: aprire il file che serve; secondaria: caricarne uno
  (o aggiungerlo da Google) perché il progetto lo abbia.
- Successo: a 1440×900, aprendo il Drive di AUD, i file che il team usa
  davvero stanno nelle prime righe senza che nessuno li abbia fissati; da
  ogni riga si capisce cos'è (tipo, provenienza, prima riga del riassunto)
  senza aprirla; un file Google si riconosce come tale e si apre su Google.
- Verità del prodotto: «Più usati» = aperture degli **ultimi 90 giorni**
  (stessa persona entro 30′ conta una); il numero è visibile a tutti, lo
  storico (chi, quando) solo con `drive.history`; un file in due progetti
  è due righe con due codici e due conteggi; nessuna cartella creata in
  Stubwise.

## 3. Direzione scelta

- **Tesi**: un **registro di prestito** di biblioteca. Una riga per
  riferimento, codice in testa, nome leggibile accanto, e a destra il
  numero di prestiti degli ultimi 90 giorni che decide l'ordine. Righe a
  due linee perché la seconda (il riassunto) è ciò che fa riconoscere un
  file di cui non si ricorda il nome. Niente miniature a griglia, niente
  icone colorate dei formati: il tipo è un glifo lineare `ink-muted`.
- **Testata** (sezione del progetto): h1 28px «Drive» + conteggio tnum
  `ink-faint` («Drive 46»); a destra «Add from Google Drive» (secondario,
  con `drive.upload`, vedi `drive-google.md`) e **Upload** (primario
  pieno d'inchiostro, come «New task», con `drive.upload`). Sotto, barra
  32px: campo «Search files» (⌘F, `drive-search.md`), menu **Sort: Most
  used ▾** (Most used · Recent · Name), filtri a gettone come in Tasks:
  **Type** (Document, Spreadsheet, Presentation, PDF, Image, Other),
  **Source** (Uploaded, Google), **Added by** (persona), e con
  `drive.manage` **Hidden** (`drive-google.md`); «Clear filters» quando
  ce n'è uno.
- **Intestazione delle colonne** 28px: Code · Name · Added by · Modified ·
  Opens (90 days). L'ultima è la colonna che ordina di default, con la
  freccia d'ordinamento visibile.
- **Gruppi delle cartelle Google collegate** in testa all'elenco: riga
  36px con glifo cartella + nome 600 («AUD – Cliente») + 12px muted
  «Google folder · 14 files · linked by Matteo Conti» + «⋯»; freccia per
  chiudere. Aperto mostra i suoi file con lo stesso ordinamento, i primi 5
  e «Show 9 more in AUD – Cliente» **[A 1]**. Poi il gruppo dei file
  sciolti, intestato `heading-group` FILES (nessun nome se non ci sono
  cartelle).
- **Riga** (56px, due linee):
  - Linea 1: codice `AUD-F7` (600, tnum) · glifo del tipo · **nome** 14px
    ink (ellissi a metà, così l'estensione resta visibile:
    «Specifiche funzionali dialer v3 … .pdf») · per Google, il glifo
    Google Drive monocromo con freccia d'uscita ↗ e nome accessibile
    «Google file, opens in Google Drive» **[A 2]**.
  - Linea 2 (13px muted): prima riga del riassunto AI, una riga con
    ellissi; al suo posto lo stato del contenuto quando non è pronto (§5).
  - Colonne a destra: avatar 20px + nome di chi l'ha aggiunto · data di
    modifica (tnum, «Oct 21», «2 h ago» oggi) · numero di aperture 90
    giorni tnum 600 allineato a destra (0 = «—» `ink-faint`). Il numero ha
    tooltip e nome accessibile «12 opens in the last 90 days».
  - Nessuna striscia di reparto (non è una task).
  - Selezione = tinta ink 10% (come Tasks); passaggio = 6% + azioni rapide
    a destra al posto della data: «Open» / «Open in Google Drive»,
    «Download» (caricati), «⋯».
- **Destinazione `#/drive`**: stessa pagina, h1 «Drive», in più la colonna
  **Project** (codice tnum + nome muted, 160px) dopo il codice, e il filtro
  **Project**. Colonna personale 240px: «All files», «Added by me»,
  «Google», filetto, `heading-group` PROJECTS con i progetti fissati e
  quelli con file, ciascuno con conteggio (scorciatoia del filtro) **[A 3]**.
  Nessun gruppo di cartella in testa: le cartelle vivono nel progetto, qui
  la riga porta «in AUD – Cliente» sulla seconda linea **[A 4]**. Upload
  dalla destinazione chiede il progetto (menu dei progetti con
  `drive.upload`; nessuno → il bottone non c'è) **[A 5]**.
- **Binario**: nuova destinazione «Drive» dopo «Calendar», prima di
  «Claude» **[A 6]**; nessun punto di segnale (il Drive non aspetta
  nessuno).
- **Momento focale**: la prima riga — il file più usato del progetto, con
  «23» nella colonna Opens e il riassunto che lo fa riconoscere.

```
1440 · Drive di AUD, dettaglio chiuso
┌rail┬project col─┬ Drive 46                      Add from Google Drive  [Upload] ┐
│    │ AUD        │ ⌕ Search files ⌘F  Sort: Most used ▾  Type ▾ Source ▾ Added by▾│
│    │ Audin 2.0  │ Code    Name                         Added by    Modified  Opens│
│    │ Overview   │ ▾ ▭ AUD – Cliente · Google folder · 14 files · linked by Matteo ⋯│
│    │ Tasks      │ AUD-F7  ▤ Contratto quadro Audin 2025 ↗  (MC) Matteo  Oct 21  23│
│    │ …          │         Framework agreement: delivery within 30 working days…  │
│    │ Docs       │ AUD-F9  ▦ Preventivo licenze 2026 ↗       (MC) Matteo  Oct 18  11│
│    │▌Drive      │         Quote for 40 seats with yearly billing and onboarding…  │
│    │ Chat       │         Show 9 more in AUD – Cliente                           │
│    │            │ FILES                                                          │
│    │            │ AUD-F2  ▧ Specifiche funzionali dialer v3.pdf (MB) Marco Oct 9 17│
│    │            │         Functional spec of the dialer: queues, callbacks, …    │
│    │            │ AUD-F12 ▨ mockup-callback-modal.png     (GF) Giulia Oct 22   — │
│    │            │         Reading the content…                                   │
└────┴────────────┴────────────────────────────────────────────────────────────────┘
```

## 4. Ambito e confini

- Dentro: elenco, gruppi delle cartelle, filtri e ordinamenti nell'URL,
  riga, dettaglio, anteprima, caricamento, stati del contenuto, destinazione
  globale, «Save to Drive» dagli allegati della Chat (entra di qui).
- Fuori: Google (`drive-google.md`), ricerca (`drive-search.md`), versioni,
  modifica in Stubwise, condivisione con esterni, cartelle create in
  Stubwise.
- **Anti-obiettivi**: un clone di Google Drive (griglia di miniature,
  albero di cartelle, «My Drive»); un contatore di sorveglianza (chi ha
  aperto cosa in vista di tutti, classifiche di persone); «Più usati» con
  stelline o «fissati» a mano; icone dei formati colorate (blu Docs, verde
  Sheets): il colore è dei reparti; un file Google che si apre dentro
  Stubwise.

## 5. Stati e intervalli

- **Volumi**: 0–500 file per progetto (elenco virtualizzato, J/K fluido);
  cartelle da 1 a 200 file; nomi fino a 255 caratteri; riassunti mancanti.
  Destinazione: migliaia di righe, a pagine.
- **Pagina**: caricamento (barra attiva, 8 righe scheletro); errore
  «Couldn't load the files» + «Retry»; vuoto — con `drive.upload`: «No
  files in AUD yet» + «Upload a file» e «Add from Google Drive», con
  `drive.manage` anche «Link a Google folder», sotto «or drop files
  anywhere on this page»; senza: «No files in AUD yet. People who can add
  files will put them here.»; nessun risultato dai filtri: «No files
  match these filters» + «Clear filters». Progetto non visibile →
  «This project doesn't exist or you can't see it» (esistente).
- **Contenuto del file** (linea 2 e dettaglio): processing «Reading the
  content…» (piccolo indicatore ink che gira, fermo con movimento ridotto)
  · ready (riassunto) · no_text «No text in this file» (`ink-faint`) ·
  unsupported «This format can't be searched by content» · error «Couldn't
  read the content» (`critical`, icona + parola) con «Retry» per
  `drive.manage` · OCR «Text read from a scan» come nota nel dettaglio.
  Un file non pronto si trova per nome (`drive-search.md`).
- **Non disponibile** (Google): riga in `ink-faint`, linea 2 con icona +
  «Not available · Deleted on Google» o «Not available · Stubwise lost
  access» (dettagli in `drive-google.md`), numero di aperture mantenuto.
- **Caricamento** (trascinando sull'intera pagina o da «Upload»):
  - Trascinando: velo della pagina con contorno tratteggiato `rule-strong`
    8px dentro l'area e testo centrale «Drop to upload to AUD» **[A 7]**;
    senza `drive.upload` il velo non compare e il cursore dice «non si
    può».
  - In corso: gruppo UPLOADING in testa all'elenco, una riga per file con
    nome, «12.4 of 48 MB» tnum e barra 2px ink; «Cancel» al passaggio. A
    fine caricamento la riga prende il suo codice e scivola al suo posto
    nell'ordinamento (200ms), con contenuto «Reading the content…».
  - Troppo grande (>100 MB): la riga non parte, compare nel gruppo con
    icona + «Too large: 101 MB, the limit is 100 MB» e «Dismiss».
  - Fallito: «Upload failed» + «Retry» · «Dismiss».
  - Nome uguale: nessuna domanda; il nuovo prende «(2)» prima
    dell'estensione e un avviso «Kept both: the new one is “mockup
    (2).png”».
- **Dopo il riavvio** dell'app: il caricato resta, l'anteprima è finta
  (pagina tipo con nota «Preview not available in this prototype session»
  solo nel prototipo) **[A 8]**.
- **Cambio di persona**: dettaglio, anteprima e caricamenti in corso si
  chiudono; filtri ripartono dall'URL validato per la persona nuova;
  nessuno storico della persona di prima resta visibile.

## 6. Dettaglio, anteprima e interazione

- **Pannello di dettaglio** (`?file=AUD-F7`): stessa meccanica del dettaglio
  task — agganciato 360px da 1200px (ridimensionabile 320–640), sotto 1200
  sovrapposto 400px con fuoco dentro e ritorno all'origine; J/K = file
  precedente/successivo nella vista; Esc chiude.
  - Testata: «AUD-F7 · Audin 2.0» 12px (codice 600), «⋯», chiudi; titolo
    = nome del file (headline 20px, a capo).
  - **Anteprima** (caricati: immagine, PDF prima pagina, testo/markdown
    prime righe) in un riquadro 16:10 con filetto, oppure **scheda Google**
    (glifo grande del tipo, «Google document · Owner: matteo@… · Modified
    on Google Oct 21»). L'anteprima nel pannello è una miniatura e **non
    conta**; conta il clic che apre l'anteprima intera **[A 9]**.
  - Azione primaria piena: «Open» (caricati con anteprima) o «Open in
    Google Drive ↗» (Google); poi «Download» (caricati), «Copy link»,
    «Cite in Chat»; distruttiva in fondo: «Delete» (caricato mio o
    `drive.manage`) o «Remove from project» (Google aggiunto da me o
    `drive.manage`) o, per i file di cartella, «Hide from project»
    (`drive.manage`). Le azioni non permesse non compaiono.
  - SUMMARY: riassunto AI intero (2–3 frasi) con nota 12px faint «Written
    by Claude from the file's content»; stati del contenuto qui per esteso.
  - DETAILS: tipo, dimensione, provenienza (Uploaded / Google, «in AUD –
    Cliente»), added by + data, modified, OCR.
  - OPENS: «23 in the last 90 days · 61 in total» tnum; con
    `drive.history` la sezione WHO OPENED IT (`drive-google.md` §storico).
  - Sezioni separate da filetti con `heading-group`, come la task.
- **Anteprima intera**: si apre sopra l'area di lavoro (binario e colonna
  restano visibili), fondo `ground`, testata 48px con codice + nome,
  «Download», «Open details», chiudi; PDF in un riquadro a tutta area,
  immagine adattata con zoom al clic, testo/markdown nel renderer a 72ch.
  ←/→ file precedente/successivo della vista; Esc chiude e torna alla riga
  **[A 10]**. Formati senza anteprima: «Open» non c'è, «Download» è
  l'azione primaria.
- **Conteggio**: l'apertura è contata all'apertura dell'anteprima intera,
  a «Open in Google Drive» (con l'avviso del prototipo «Opened in Google
  Drive») e al download; il numero sulla riga sale dopo, senza animazione
  vistosa (dissolvenza del numero 150ms).
- **Copy link**: copia `#/p/AUD/drive?file=AUD-F7`; avviso «Link copied».
  **Cite in Chat**: apre il dialogo «Share to…» della Chat con il gettone
  `AUD-F7` già nella casella (canale del progetto preselezionato) **[A 11]**.
- **Save to Drive** sull'allegato di un messaggio di Chat (`drive.upload`):
  in un canale di progetto salva lì con avviso «Saved to AUD Drive as
  AUD-F31 · Open»; in DM o generale apre il menu dei progetti con
  `drive.upload` (codice + nome, ricerca); nessuno → la voce non c'è.
- **1024×680**: area 720px. Colonne: cade «Modified» (resta nel dettaglio
  e nel tooltip), «Added by» diventa solo avatar; la barra va su due righe
  (campo + Sort / filtri). Il dettaglio è sempre sovrapposto 400px.
  Destinazione: la colonna Project mostra solo il codice.
- **Movimento**: riga caricata che prende posto 200ms; pannello e
  anteprima entrano in 200ms dall'alto/da destra con l'ease del sistema;
  niente con movimento ridotto.

## 7. Tastiera e accessibilità

- J/K muovono la selezione; Enter apre il dettaglio; **Space** apre
  l'anteprima intera (come Quick Look) o il file Google; ⌘O apre il file;
  ⌘⇧U Upload; ⌘F cerca; ⌘C sulla riga selezionata copia il link; Esc chiude
  anteprima → dettaglio → selezione **[A 12]**.
- L'elenco è una `grid` con intestazioni di colonna e `aria-sort`; il
  gruppo cartella è una riga con `aria-expanded`; ogni riga ha un nome
  accessibile completo: «AUD-F7, Contratto quadro Audin 2025, Google
  document, added by Matteo Conti, 23 opens in the last 90 days».
- L'avanzamento dei caricamenti è `progressbar` con valore; fine, errore e
  «Kept both» sono annunciati `polite`. Stati del contenuto con parola, mai
  solo colore. La zona di rilascio ha l'alternativa del bottone Upload.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| h1 | Drive | Drive |
| azioni | Upload · Add from Google Drive | Carica · Aggiungi da Google Drive |
| ordinamento | Most used · Recent · Name | Più usati · Recenti · Nome |
| filtri | Type · Source · Added by · Hidden · Project | Tipo · Provenienza · Aggiunto da · Nascosti · Progetto |
| tipi | Document · Spreadsheet · Presentation · PDF · Image · Other | Documento · Foglio · Presentazione · PDF · Immagine · Altro |
| provenienza | Uploaded · Google | Caricato · Google |
| colonna | Opens (90 days) | Aperture (90 giorni) |
| aperture | {{count}} opens in the last 90 days · {{total}} in total | {{count}} aperture negli ultimi 90 giorni · {{total}} in tutto |
| cartella | Google folder · {{count}} files · linked by {{name}} | Cartella Google · {{count}} file · collegata da {{name}} |
| contenuto | Reading the content… · No text in this file · This format can't be searched by content · Couldn't read the content | Lettura del contenuto… · Nessun testo in questo file · Questo formato non si cerca per contenuto · Non è stato possibile leggere il contenuto |
| caricamento | Drop to upload to {{code}} · Too large: {{size}}, the limit is 100 MB · Kept both: the new one is “{{name}}” | Rilascia per caricare in {{code}} · Troppo grande: {{size}}, il limite è 100 MB · Tenuti entrambi: il nuovo è «{{name}}» |
| vuoto | No files in {{code}} yet | Ancora nessun file in {{code}} |
| riassunto | Written by Claude from the file's content | Scritto da Claude dal contenuto del file |
| Google | Open in Google Drive · Opened in Google Drive | Apri in Google Drive · Aperto in Google Drive |
| chat | Save to Drive · Saved to {{code}} Drive as {{file}} | Salva nel Drive · Salvato nel Drive di {{code}} come {{file}} |

## 9. Vincoli

- Visibilità solo da `canSeeDriveFile`; pagine da `data/queries.ts`;
  orologio fisso del prototipo per «90 giorni» e «2 h ago».
- Il caricamento legge nome, tipo e dimensione veri nel renderer; object
  URL revocati alla chiusura dell'app; nessun lavoro nel processo main.
- Filtri, ordinamento e `?file=` nell'URL (validati come gli altri
  parametri in `data/routes.ts`).

## Assunzioni da confermare

1. Un gruppo di cartella aperto mostra i primi 5 file (nell'ordinamento
   scelto) e «Show N more»; i gruppi partono aperti e lo stato aperto/chiuso
   si ricorda per persona e progetto. Così i file più usati restano sopra
   la piega anche con una cartella da 200 file.
2. La provenienza Google è un glifo monocromo del Drive + freccia ↗ (nessun
   colore del marchio Google), con nome accessibile in parole.
3. La destinazione `#/drive` ha una colonna personale (All files, Added by
   me, Google, PROJECTS con conteggi come scorciatoie del filtro).
4. Nella destinazione non ci sono gruppi di cartella: la cartella è scritta
   sulla seconda linea della riga.
5. «Upload» dalla destinazione chiede prima il progetto (solo quelli con
   `drive.upload`); senza nessuno il bottone non c'è.
6. «Drive» sul binario va dopo «Calendar» e prima di «Claude», senza
   segnale.
7. Il trascinamento accetta file su tutta la pagina del Drive (velo con
   contorno tratteggiato); fuori dal Drive (es. Overview) non fa nulla.
8. Dopo un riavvio del prototipo un caricato mostra un'anteprima tipo
   finta con una nota da prototipo.
9. La miniatura nel pannello di dettaglio non conta come apertura; conta
   solo l'anteprima intera (o Google, o download).
10. L'anteprima intera copre l'area di lavoro (non tutta la finestra) e ha
    ←/→ per scorrere i file della vista.
11. «Cite in Chat» apre un dialogo «Share to…» con il canale del progetto
    preselezionato e il gettone già nella casella (non incolla in un canale
    aperto a caso).
12. Space = anteprima (come Quick Look), ⌘O apre, ⌘⇧U carica.
13. Righe a due linee da 56px (riassunto sempre visibile); nessuna vista a
    griglia di miniature, nemmeno per MKX con molti file grafici.
14. Il preset `legacy_member` riceve `drive.upload` come Developer e
    Contributor (lo spec non lo nomina).
