# Shape brief — Ricerca nella Chat e gruppo «Messages» in ⌘K

Superficie: `pages/chat/ChatSearch.tsx` (`#/chat/search?q=…&…`) e il
gruppo «Messages» del palette (`palette/*`). Piano: Task 7. Spec: area 4
«Ricerca», «Privacy». Mondo: «Catalogo numerato», modalità **Operate**.
**[ASSUNZIONE]** = da confermare.

## 1. Lavoro e pubblico

- Chi ritrova «quella cosa che Marco aveva scritto sul listino», chi
  cerca dove si è parlato di AUD-88, chi recupera un file allegato due
  mesi fa. È la ragione per cui la Chat esiste (lo storico di Slack
  gratuito spariva): la ricerca deve funzionare anche su messaggi vecchi.
- Stato d'animo: sa più o meno cosa cerca, non dove; vuole arrivare al
  messaggio **nel suo contesto**, non leggerlo isolato.

## 2. Esito e prova

- Azione primaria: trovare il messaggio e saltarci, evidenziato, nel
  canale o nel thread.
- Successo: dai risultati si capisce chi, dove e quando senza aprirli; i
  filtri restringono in un clic; nessun risultato rivela qualcosa che chi
  cerca non potrebbe leggere.
- Verità del prodotto: si cerca solo nei canali che chi cerca **può
  leggere** (`canReadChannel`): mai privati di cui non è membro (nemmeno
  se li gestisce), mai DM altrui; i messaggi eliminati non esistono per la
  ricerca; gli archiviati sì.

## 3. Direzione scelta

- **Tesi**: una pagina di risultati nell'area di lavoro della Chat, con la
  colonna intatta; i risultati sono **frammenti del flusso** (stessa resa
  del messaggio, più piccoli) raggruppati per canale, non righe di
  tabella. Il contesto è una riga sopra, sbiadita.
- **Ingresso**: il campo «Search messages ⌘F» in testa alla colonna
  (`chat.md`); premendo Enter si apre la pagina con il campo spostato
  nell'h1 della pagina **[ASSUNZIONE: il campo della colonna resta
  sincronizzato con la query]**. Da ⌘K «Search all messages for “…”».
- **Testata**: campo grande 40px a tutta larghezza (fuoco, × per svuotare)
  al posto dell'h1, poi la barra filtri: **In** (canale, ricerca dentro il
  menu, raggruppato come la colonna), **From** (persona, include
  «Claude»), **Date** («Any time», «Today», «Last 7 days», «Last 30
  days», «Custom range…»), interruttori **With attachments**, **With
  citations**, **People only** (esclude i messaggi di sistema); a destra
  «Clear filters» quando ce n'è uno. Sotto, 13px muted «38 messages in 6
  channels».
- **Gruppi**: uno per canale, intestato da una riga 28px con codice 600 +
  nome + conteggio e filetto sotto — non `heading-group`, perché il nome
  di un canale è un dato e non va in maiuscolo spaziato
  **[ASSUNZIONE]**; ordine dei gruppi per corrispondenza più
  recente; dentro, i più recenti in alto; 3 risultati per gruppo e «Show
  12 more in AUD · general».
- **Risultato** (≥ 56px): riga contesto 12px faint (il messaggio
  precedente, una riga con ellissi, «Marco Bellini: Did anyone…»), poi
  avatar 24px + «Elena Moretti · Oct 14, 16:02» + testo 14px fino a 3
  righe con le parole trovate **evidenziate** (fondo ink 14% e peso 600,
  mai colore); citazioni come gettoni codice + nome (R-E9 vale);
  allegati come chip; risposta in un thread: riga «in a thread: Export is
  green…»; in un archiviato, «Archived» dopo il nome canale.
- **Momento focale**: il primo risultato con la parola evidenziata, già
  selezionato (J/K per muoversi).

```
┌column────────────┬──────────────────────────────────────────────────────┐
│ [+ New message]  │ [⌕ price list                                    × ] │
│ ⌕ price list     │ In ▾  From ▾  Date ▾  ○With attachments ○With citations│
│ Threads       2  │ 38 messages in 6 channels                            │
│ Mentions      1  │ AUD general                                       14 │
│ …                │ ──────────────────────────────────────────────────── │
│                  │   Marco Bellini: Did anyone hear from the supplier?  │
│                  │ ▌(EM) Elena Moretti · Oct 14, 16:02                  │
│                  │ ▌ The new ▓price list▓ is in AUD-91 Price list sync, │
│                  │ ▌ due Friday.                                        │
│                  │   (GF) Giulia Ferri · Oct 2 · in a thread: Supplier… │
│                  │   Can we import the ▓price list▓ as CSV?             │
│                  │   Show 12 more in AUD · general                      │
│                  │ MKX grafica                                        3 │
└──────────────────┴──────────────────────────────────────────────────────┘
```

## 4. Ambito e confini

- Dentro: campo, filtri, risultati raggruppati con contesto, salto ed
  evidenza nel canale/thread, stati, gruppo «Messages» e «Channels» in ⌘K.
- Fuori: ricerca dei Docs (RAG) e degli oggetti (già in ⌘K); sintassi
  avanzata («from:», «in:») **[ASSUNZIONE: solo filtri cliccabili nel
  prototipo]**; ricerche salvate.
- Anti-obiettivi: un conteggio o un titolo che riveli un canale privato
  non leggibile («3 results you can't see»: no); risultati di messaggi
  eliminati; un'evidenza a colori.

## 5. Stati e intervalli

- Query da 2 caratteri in su (sotto: niente ricerca, suggerimento «Type at
  least 2 characters»); corrispondenza per parola, senza differenza fra
  maiuscole e accenti **[ASSUNZIONE]**; un codice («AUD-88») trova anche i
  messaggi che lo citano come gettone.
- Volumi: 0–migliaia di risultati; i gruppi si caricano a pagine di 20
  canali, scorrendo.
- **Vuoto della pagina** (nessuna query): ultime 5 ricerche di chi guarda
  come righe cliccabili + «Clear» **[ASSUNZIONE]**.
- **Nessun risultato**: «No messages match “price lsit”» + «Clear
  filters» se ci sono filtri, altrimenti «Try fewer words or another
  spelling».
- Caricamento: barra filtri attiva, 3 gruppi scheletro. Errore: «Couldn't
  search messages» + «Retry».
- Il messaggio non è più leggibile al momento del clic (rimosso dal
  canale, eliminato): toast «This message is no longer available» e si
  resta sulla pagina.
- Cambio di persona: la pagina si svuota (query compresa) e torna allo
  stato iniziale.

## 6. Interazione e layout

- **Salto**: clic/Enter → canale, scorrimento centrato sul messaggio,
  **evidenza**: fondo ink 10% che svanisce in 2s (con movimento ridotto:
  resta 2s e sparisce senza dissolvenza); se è una risposta, si apre il
  pannello del thread e l'evidenza è nel pannello. «Back to results»
  (pillola in testa al canale, e ⌘[ ) torna alla pagina con query,
  filtri e posizione **[ASSUNZIONE]**.
- Tastiera: ⌘F dentro la Chat mette il fuoco nel campo; ↓ dal campo entra
  nei risultati; J/K muovono, Enter apre, Esc nel campo vuoto torna al
  canale di prima.
- Filtri: menu flottanti 280px con ricerca; i filtri attivi sono gettoni
  con «×»; tutto nell'URL, così il link a una ricerca si condivide (e chi
  lo apre vede solo ciò che lui può leggere).
- **⌘K**: dopo i gruppi degli oggetti, `heading-group` CHANNELS (canali
  leggibili il cui nome corrisponde, codice · nome, «Go to») e MESSAGES:
  massimo 5 righe 52px — «Elena Moretti in AUD · general · Oct 14» 12px
  muted, sotto una riga di testo con la parola evidenziata; Enter salta
  come sopra. Ultima riga del gruppo: «Search all messages for “price
  list”» (apre la pagina con la query). Il gruppo compare da 2 caratteri
  e dopo i gruppi più esatti **[ASSUNZIONE]**.
- 1024px: i tre interruttori finiscono in un menu «More filters».
- Movimento: risultati in dissolvenza 150ms al cambio di filtro, senza
  spostare la barra.

## 7. Vincoli e decisioni aperte

- Una sola funzione decide cosa si cerca (`searchChat` sopra
  `canReadChannel`); palette e pagina usano la stessa.
- Il testo evidenziato è annunciato come tale (`<mark>`); ogni risultato
  ha un nome accessibile «Elena Moretti in AUD · general, Oct 14: …».
- **[ASSUNZIONE]** Le ricerche recenti restano solo sul dispositivo di
  chi cerca e si cancellano al cambio di persona.
