# Shape brief — Ricerca nei file, gruppo «Files» di ⌘K, citazione «#»

Superficie: il campo «Search files» del Drive (progetto e destinazione) e
i suoi risultati, il gruppo **Files** (e **Pages** dei Docs) in ⌘K, i file
Google fuori dai progetti nei risultati, la citazione «#» di un file del
Drive (Chat, task, Claude) con la sua anteprima, i codici `AUD-F7`
scritti a mano, le fonti Drive nelle risposte di Claude e delle chat dei
Docs. Piano: Task 8–9. Spec: area 5 «Ricerca nei file», «Aperture»,
«Claude», «Citazioni», «Casi limite»; area 4 R-G5; area 3 R-E9. Mondo:
«Catalogo numerato», modalità **Operate**. Coerente con
`chat-search.md` (stessa evidenziazione, stesso ritmo). **[A n]** =
assunzione numerata in fondo.

## 1. Lavoro e pubblico

- Chi non ricorda il nome del file ma ricorda cosa c'era dentro: «il
  documento con le penali sui ritardi», «quella presentazione con il
  grafico dei volumi di chiamata». È la prima fatica dichiarata dal
  maintainer.
- Chi lavora in Chat o con Claude e vuole citare un file senza uscire.
- Chi ha un file nel proprio Google Drive che non è ancora in nessun
  progetto e lo trova da Stubwise.

## 2. Esito e prova

- Azione primaria: trovare il file per contenuto e aprirlo.
- Successo: dal risultato si capisce **perché** è uscito (passaggio
  evidenziato o «nome») e **se è quello giusto** (riassunto) senza aprirlo;
  a parità di pertinenza, il file più usato viene prima; nessun risultato
  rivela un file che chi cerca non può vedere.
- Verità del prodotto: mostrare un risultato o il suo riassunto **non**
  conta come apertura, aprirlo sì; un file non pronto o non disponibile si
  trova solo per nome; un file Google fuori dai progetti compare solo a chi
  ha l'account collegato e lo vede su Google; Claude legge i file (stesse
  regole) ma la sua lettura non conta.

## 3. Direzione scelta

- **Tesi**: il risultato è la **scheda di catalogo** del file: codice e
  nome in testa, il riassunto come «abstract», il passaggio trovato come
  citazione con la parola marcata. Stessa evidenziazione della ricerca
  Chat (fondo ink 14% + peso 600, `<mark>`, mai colore).
- **Nel Drive** (progetto o destinazione): scrivere nel campo «Search
  files» (da 2 caratteri, 200ms di attesa) sostituisce l'elenco con i
  risultati, mantenendo ordinamento disattivato («Sorted by relevance») e
  filtri attivi (Type, Source, Added by, Project). Sotto la barra, 13px
  muted: «18 files match “penali”». Esc o × svuota e torna all'elenco
  com'era (posizione e selezione) **[A 1]**.
- **Risultato** (72–96px, tre linee):
  - Linea 1: codice tnum 600 · glifo tipo · **nome** (parole trovate
    evidenziate anche qui) · ↗ se Google · a destra il numero di aperture 90
    giorni tnum (come la colonna Opens) e, nella destinazione, il progetto
    (codice + nome muted).
  - Linea 2 (13px ink-muted): riassunto, fino a 2 righe.
  - Linea 3 (13px ink, filetto sinistro 2px `rule-strong` come una
    citazione): il passaggio del testo che corrisponde, una o due righe
    con ellissi ai lati, parole evidenziate; con OCR, «from a scan» 12px
    faint dopo il passaggio. Se ha corrisposto solo il nome: la linea 3 è
    «Matched the name» in `ink-faint` **[A 2]**.
  - File non pronto: linea 2–3 sostituite da «Reading the content… found by
    name». Non disponibile: riga `ink-faint` con «Not available · found by
    name».
- **Ordine**: pertinenza; a parità, aperture 90 giorni; poi modifica più
  recente. Nessun raggruppamento per cartella nei risultati **[A 3]**.
- **File Google fuori dai progetti**: in coda, dopo un filetto, gruppo
  `heading-group` IN YOUR GOOGLE DRIVE con nota 12px «Not in a project
  yet. Only you can see these results.»; righe senza codice (non è ancora
  un riferimento) **[A 4]**: glifo · nome · proprietario · modifica ·
  riassunto. «Open» apre su Google e poi «Which project?»
  (`drive-google.md`). Massimo 5, «Show more».
- **Account non collegato** (o scaduto): al posto di quel gruppo, una riga
  quieta «Connect your Google account to also search files in your Google
  Drive · Connect» (scaduto: «Your Google connection expired · Reconnect»);
  i file Google già nei progetti si trovano comunque.
- **⌘K, gruppo FILES**: compare da 2 caratteri, al più 5 righe 52px: linea
  1 codice · nome · progetto (codice) muted · ↗ se Google; linea 2 il
  passaggio evidenziato (o il riassunto, se ha corrisposto il nome). Ultima
  riga del gruppo, in «More»: «Search all files for “penali”» (apre la
  destinazione Drive con la query). I file Google fuori dai progetti
  entrano come ultime righe del gruppo con «Not in a project» al posto
  del codice. **Ordine dei gruppi** in ⌘K: Projects · Tasks · Requests ·
  Pages · Files · People · Channels · Messages · Actions · More **[A 5]**.
  Il gruppo PAGES (Docs) usa la stessa riga con codice `AUD-D12`, titolo,
  progetto e passaggio.
- **Aprire da un risultato** (Drive o ⌘K): Enter/clic **apre il file**
  (anteprima intera per i caricati, «Open in Google Drive» per Google) e
  conta; ⌥Enter o il bottone «Details» apre solo il pannello di dettaglio
  (`?file=`) senza contare **[A 6]**.
- **Citazione «#»** (Chat, descrizione/commenti di task, conversazione con
  Claude): il menu «#» ha un gruppo FILES dopo task, richieste e pagine
  **[A 7]**: righe codice · nome · tipo · progetto, filtrate per nome e
  codice (non per contenuto: il menu è veloce) **[A 8]**. Inserito, il
  gettone è codice + nome come gli altri oggetti. **Anteprima** al
  passaggio o al fuoco (popover 320px, ombra dei flottanti): glifo tipo
  grande · nome · «Google spreadsheet · AUD Audin 2.0» · riassunto (3
  righe) · aperture 90 giorni · «Open» / «Open in Google Drive ↗». Clic
  sul gettone = apre il file (conta).
- **R-E9 e R-G5**: un file che chi legge non vede (progetto invisibile,
  nascosto, tolto, codice inesistente) è il gettone «An item you can't
  open» già esistente, identico in tutti i casi; un `AUD-F7` scritto a mano
  diventa link con anteprima solo se visibile, altrimenti resta testo.
  Un file **non disponibile** ma visibile è un gettone normale con
  «Not available» nell'anteprima.
- **Fonti di Claude e chat dei Docs**: nella riga «Used:» i file compaiono
  come le pagine — codice + nome, con ↗ se Google; aprire una fonte apre il
  file (conta: è chi legge che apre, non Claude). Nella risposta di
  esempio («what does the client contract say about delivery times?») la
  citazione inline è `AUD-F7 Contratto quadro Audin 2025` col passaggio
  parafrasato e il numero di articolo.
- **Momento focale**: il passaggio evidenziato sotto il riassunto del primo
  risultato, già selezionato.

```
1440 · ricerca nel Drive di AUD
┌ Drive 46 ─────────────────────────────────────────────────────────────┐
│ [⌕ penali ritardo                    ×]  Type ▾  Source ▾  Added by ▾  │
│ 6 files match “penali ritardo” · Sorted by relevance                  │
│ AUD-F7  ▤ Contratto quadro Audin 2025 ↗                           23 │
│          Framework agreement for Audin 2.0: scope, delivery in 30     │
│          working days, support levels and termination.                │
│        ┃ …in caso di ▓ritardo▓ oltre i 10 giorni lavorativi si        │
│        ┃ applicano ▓penali▓ dello 0,5% per settimana…                 │
│ AUD-F2  ▧ Specifiche funzionali dialer v3.pdf                     17 │
│          …                                                            │
│ ───────────────────────────────────────────────────────────────────── │
│ IN YOUR GOOGLE DRIVE  Not in a project yet. Only you can see these.   │
│ ▤ Bozza contratto Tessitura 2026 ↗ · Owner: you · Oct 12      Open    │
└───────────────────────────────────────────────────────────────────────┘
```

## 4. Ambito e confini

- Dentro: campo e risultati nel Drive (progetto e destinazione), gruppi
  Files e Pages di ⌘K, file Google esterni nei risultati, menu «#»,
  gettone e anteprima `drive`, codici `<PRJ>-F<n>` a mano, fonti Drive di
  Claude e chat dei Docs.
- Fuori: «Which project?» e account (`drive-google.md`); la ricerca nella
  Chat (`chat-search.md`); sintassi avanzata («type:pdf») — solo filtri
  cliccabili **[A 9]**; ricerche salvate.
- **Anti-obiettivi**: un conteggio o un titolo che riveli file non
  visibili («2 more files you can't see»: no); evidenze colorate; contare
  un'apertura perché un risultato è comparso o è stato letto da Claude;
  file Google esterni mescolati ai risultati del progetto come se ne
  facessero parte.

## 5. Stati e intervalli

- Query < 2 caratteri: nessuna ricerca, l'elenco resta. Corrispondenza
  senza differenza di maiuscole e accenti; un codice esatto («AUD-F7»)
  porta il file in testa **[A 10]**.
- Volumi: 0–centinaia di risultati, 20 per pagina, scorrendo.
- Caricamento: barra attiva, 3 risultati scheletro. Errore: «Couldn't
  search the files» + «Retry».
- Nessun risultato: «No files match “penali ritrado”» + «Clear filters» se
  ce ne sono, altrimenti «Try other words: search looks inside files
  too»; se l'account Google non è collegato, la riga «Connect» resta sotto.
- Risultato non più visibile al clic (tolto, nascosto, permesso perso):
  avviso «This file is no longer available» e si resta sui risultati.
- Cambio di persona: query e risultati azzerati; il gruppo Google esterno
  sparisce o si ricalcola sull'account della persona nuova; anteprime di
  gettoni chiuse.

## 6. Interazione e layout

- Tastiera: ⌘F nel Drive mette il fuoco nel campo; ↓ entra nei risultati;
  J/K muovono; Enter apre il file; ⌥Enter apre il dettaglio; Esc nel campo
  svuota, Esc nel campo vuoto torna all'elenco. In ⌘K: ↑/↓, Enter apre,
  ⌥Enter dettaglio.
- Menu «#»: ↑/↓, Enter inserisce, Esc chiude; il gettone si cancella con ⌫
  intero.
- 1024×680: la colonna aperture resta (è l'ordine secondario), il progetto
  nella destinazione resta solo codice; il passaggio si limita a una riga.
  L'anteprima del gettone si apre sopra o sotto secondo lo spazio.
- Movimento: risultati in dissolvenza 150ms al cambio di query o filtro,
  senza spostare la barra; nulla con movimento ridotto.

## 7. Accessibilità

- Ogni risultato ha un nome accessibile «AUD-F7, Contratto quadro Audin
  2025, Google document, AUD. Summary: … Matched: … 23 opens in the last
  90 days.»; le parole trovate sono `<mark>`.
- Il conteggio dei risultati è annunciato `polite` dopo l'attesa, non a
  ogni tasto.
- Il gruppo Google esterno ha la sua intestazione e la nota «Only you can
  see these results» letta prima delle righe.
- Anteprima del gettone: raggiungibile da tastiera (fuoco sul gettone la
  apre dopo 250ms, Esc la chiude), `role="dialog"` non modale con
  etichetta.

## 8. Testi chiave (en / it)

| Chiave | en | it |
|---|---|---|
| campo | Search files | Cerca nei file |
| conteggio | {{count}} files match “{{q}}” · Sorted by relevance | {{count}} file corrispondono a «{{q}}» · Ordinati per pertinenza |
| nome | Matched the name · found by name | Corrisponde il nome · trovato per nome |
| scan | from a scan | da una scansione |
| Google esterno | In your Google Drive · Not in a project yet. Only you can see these results. | Nel tuo Google Drive · Non ancora in un progetto. Solo tu vedi questi risultati. |
| account | Connect your Google account to also search files in your Google Drive · Connect | Collega l'account Google per cercare anche nei file del tuo Google Drive · Collega |
| ⌘K | Files · Pages · Search all files for “{{q}}” · Not in a project | File · Pagine · Cerca «{{q}}» in tutti i file · Non in un progetto |
| vuoto | No files match “{{q}}” · Try other words: search looks inside files too | Nessun file corrisponde a «{{q}}» · Prova altre parole: la ricerca guarda anche dentro i file |
| sparito | This file is no longer available | Questo file non è più disponibile |
| gettone | An item you can't open · Not available | Un elemento che non puoi aprire · Non disponibile |
| dettaglio | Details | Dettagli |

## 9. Vincoli

- Una sola funzione (`searchDrive` sopra `canSeeDriveFile`) per Drive, ⌘K,
  menu «#» e Claude; evidenziazione con `highlightParts` della Chat.
- `recordOpen` solo su apertura esplicita (anteprima intera, Google,
  download), mai da risultati, anteprime di gettoni o letture di Claude.
- Codici `<PRJ>-F<n>` in `resolveCodes` con R-G5; citazione `drive`
  accanto a `file` (che resta il file di un repository).

## Assunzioni da confermare

1. Cercare nel Drive sostituisce l'elenco con i risultati (ordinati per
   pertinenza, filtri mantenuti) e svuotare il campo riporta l'elenco
   com'era; nessuna pagina di ricerca separata.
2. Il risultato ha tre linee (nome, riassunto, passaggio); se ha
   corrisposto solo il nome la terza linea dice «Matched the name».
3. Nei risultati non ci sono gruppi di cartella: ordine piatto per
   pertinenza, poi aperture 90 giorni, poi modifica.
4. I file Google fuori dai progetti stanno in un gruppo in coda, senza
   codice (lo prendono solo quando entrano in un progetto), con la nota
   «Only you can see these results».
5. Ordine dei gruppi di ⌘K: Projects · Tasks · Requests · Pages · Files ·
   People · Channels · Messages · Actions · More (il gruppo Pages dei Docs
   nasce con quest'area).
6. Enter su un risultato apre il file e conta; ⌥Enter (o «Details») apre
   il pannello di dettaglio senza contare.
7. Nel menu «#» i file stanno dopo task, richieste e pagine.
8. Il menu «#» filtra per nome e codice, non per contenuto (la ricerca per
   contenuto è del campo del Drive e di ⌘K).
9. Niente sintassi avanzata nel campo («type:», «from:»): solo filtri
   cliccabili.
10. Un codice esatto scritto nel campo (`AUD-F7`) porta quel file in testa
    ai risultati.
11. L'anteprima del gettone `drive` mostra le aperture degli ultimi 90
    giorni; il totale resta solo nel dettaglio del file.
