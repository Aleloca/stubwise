# Widget trascinabile — design

Data: 29 set 2026. Stato: approvato.

## Problema

La bolla del widget di assistenza (`packages/widget`) è fissa in basso a
destra (`bottom: 20px; right: 20px`) e il pannello si apre sopra di lei. Su
alcuni siti dei clienti in quel punto ci sono già altre funzionalità (pulsanti
flottanti, chat di terzi), che la bolla copre.

## Decisioni

- **Posizione libera ma agganciata al bordo laterale**: l'utente trascina la
  bolla; al rilascio scivola sul bordo sinistro o destro più vicino e mantiene
  l'altezza scelta. Scartati gli angoli soli (troppo pochi posti liberi) e la
  posizione completamente libera (copre il contenuto, pannello da posizionare
  in 2D, resize ambiguo).
- **Solo lato utente**, nessuna posizione predefinita scelta dall'admin: il
  default resta in basso a destra. Nessuna migrazione, nessun campo nuovo nella
  config pubblica, deploy del solo `caddy`.

## 1. Trascinamento e posizione salvata

- **Stato persistito**: `{ side: "left" | "right", y: number }` in
  `localStorage`, chiave `stubwise-widget:<slug>:position`. `y` è il centro
  verticale della bolla come **frazione** dell'altezza del viewport (0–1): la
  posizione sopravvive al resize e al cambio di schermo.
  `getPosition`/`setPosition` in `core/storage.ts`, stesso degrado delle
  funzioni della conversazione (storage che lancia → default / no-op). Un
  valore non parsabile o fuori range si scarta → default.
- **Default**: `right`, bolla a 20px dal fondo, identica a oggi. Chi non
  trascina non vede differenze.
- **Click vs trascinamento**: Pointer Events (mouse, touch e penna con un solo
  codice). Spostamento < 5px = click (apre/chiude come oggi); oltre la soglia è
  un trascinamento e il click successivo viene soppresso. Durante il
  trascinamento la bolla segue il puntatore; al rilascio si aggancia al bordo
  più vicino (metà sinistra del viewport → sinistra) con una breve transizione,
  e si salva.
- **Limiti**: la bolla resta sempre intera nel viewport, con 20px di margine
  sopra e sotto. Al `resize` la posizione si ricalcola dalla frazione e si
  riporta dentro i limiti.
- **Touch**: `touch-action: none` sulla bolla, così trascinarla non scorre la
  pagina.
- **Tastiera**: il trascinamento è un di più; la bolla resta un bottone
  normale.
- **Col pannello aperto** la bolla si trascina e il pannello la segue. Sotto i
  480px il pannello è a schermo intero e la bolla nascosta: invariato.

### Maniglia (aggiunta dopo la prima prova manuale)

Il trascinamento non si scopre da solo. Finché l'utente non ha mai spostato la
bolla, sul lato rivolto al centro della pagina spunta da dietro il cerchio una
linguetta a pillola un tono più scura, coi puntini
(⠿) e la bolla ha il tooltip «Trascina per spostare». "Mai spostata" coincide
con "nessuna posizione salvata": nessun flag a parte. Nascosta a chat aperta
(la bolla è il tasto chiudi). Scartati: il solo cursore `grab` (invisibile su
telefono), un suggerimento temporaneo una tantum, i puntini dentro il cerchio
(poco leggibili su 56px) e un badge d'angolo (scambiabile per un contatore).
Costo accettato: chi non sposta mai la bolla vede la maniglia sempre, quindi
dev'essere piccola.

## 2. Posizionamento del pannello

Funzione pura `placePanel(viewport, bubble)` in `ui/placement.ts`.

- **Orizzontale**: stesso lato della bolla, 20px dal bordo.
- **Verticale**: centro della bolla nella metà bassa → pannello **sopra**;
  metà alta → **sotto**; 12px di distanza dalla bolla. Altezza
  `min(600, spazio disponibile in quella direzione − 20)`.
- **Caso stretto**: se in quella direzione restano meno di 360px, il pannello
  si apre **di fianco** alla bolla (verso l'interno), alto quanto il viewport
  meno 20px sopra e sotto: resta intero e non copre la bolla.
- **Ricalcolo** all'apertura, durante il trascinamento e al `resize`.
- **Mobile**: la geometria passa al CSS come **variabili** (`--sw-bubble-*`,
  `--sw-panel-*`) sul root, non come stili inline, così la media query
  `max-width: 480px` (pannello `inset: 0`) continua a vincere senza eccezioni in
  JS.

## 3. Test

- Unitari su `placePanel`: lato sinistro/destro, sopra, sotto, di fianco,
  viewport minuscolo.
- Unitari su aggancio al bordo e conversione frazione ↔ pixel con limiti.
- Storage: assente, corrotto, fuori range, `localStorage` che lancia.
- `widget.test.tsx` con Pointer Events in happy-dom: movimento < 5px apre la
  chat; trascinamento non la apre e salva; al rimontaggio la bolla riparte
  dalla posizione salvata.
- Manuale: pagina reale, desktop e telefono.

## Deploy

Solo `caddy` (il bundle `/widget.js` è buildato in `Dockerfile.caddy`).
Nessuna migrazione, nessun cambio al server. Rollback: immagine caddy
precedente; la chiave in `localStorage` resta innocua e ignorata.
