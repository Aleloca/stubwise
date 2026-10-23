# Ossatura — cose rimaste aperte (23 ott 2026)

Emerse dalle revisioni della parte 1 (ossatura) e lasciate deliberatamente
per dopo. Da riprendere all'inizio dell'area 2, prima di costruirci sopra.

## Primo passo dell'area 2

- **Livello dati consapevole di chi guarda.** Oggi «vedi come» cambia i
  permessi ma non i dati: ogni persona vede i progetti fissati, le notifiche
  e i segnali di Giulia, e un Contributor trova via ⌘K anche progetti di cui
  non è membro (il server risponderebbe 404). Serve una «sessione» nel
  livello finto (`currentPersonId` in `data/api.ts`, impostato da
  `ViewerProvider`, nelle chiavi delle query), con filtri per membro e
  destinatario su `listProjects`, `search`, `listNotifications`, progetti
  fissati. Reparti e persone letti via query, non importando il seed
  (`DeptStrip`, `ProfileMenu`).
- **`DetailPanel`** (`layout/useDetailPanel.ts`): Esc globale che ignora
  `defaultPrevented` (con la palette aperta chiude entrambi) e nessun
  spostamento/ritorno del fuoco nella modalità sovrapposta.
- **Windows**: l'overlay dei controlli finestra copre l'angolo in alto a
  destra dell'area di lavoro; le testate delle pagine devono riservare
  ~32px in alto e ~140px a destra (o `env(titlebar-area-*)`).
- **Segnale «ti aspetta»** sulle tessere: oggi non è legato a task o
  decisioni reali del seed.

## Minori, quando capita

- Testata della colonna di progetto su query fallita: mostra solo il codice.
- URL di progetto in minuscolo (`#/p/aud`) non normalizzati.
- Mutazioni delle notifiche senza `onError` e non ottimistiche.
- Menu dell'applicazione solo in inglese (serve la lingua del renderer via IPC).
- Primo disegno col tema del sistema, non con la preferenza salvata.
- Allineamento dei semafori macOS col logo da verificare a occhio.
- Freccette nella navigazione del menu profilo e del menu «rimanda».
- `capture.mjs`: uccidere il gruppo di processi di vite, non solo pnpm.
- Con la finestra alla minima altezza il binario mostra poche tessere.
