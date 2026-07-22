---
description: Collega uno o più repository a un progetto Stubwise scrivendo il file .stubwise.json in ogni radice git.
---

Il tuo compito è collegare la cartella corrente (o le repo che contiene) ai
progetti Stubwise, scrivendo un file `.stubwise.json` in ogni radice git.

Il file ha SEMPRE questa forma:

```json
{ "project": "<slug-del-progetto>" }
```

Segui questi passi con precisione, senza saltarne nessuno.

## 1. Scopri le radici git

Determina le radici git a partire dalla cartella corrente:

- Se la cartella corrente è essa stessa una repo (contiene `.git`), la radice è
  una sola: quella cartella.
- Se invece è una cartella-padre che contiene più repository (più sottocartelle,
  ciascuna con una propria `.git`), le radici sono TUTTE quelle sottocartelle.

Usa comandi shell per capirlo, ad esempio:

```bash
# la cartella corrente è una repo?
git rev-parse --show-toplevel 2>/dev/null
# oppure elenca le sottocartelle che sono radici git
find . -maxdepth 2 -name .git -type d 2>/dev/null
```

Elenca all'utente le radici che hai trovato prima di procedere.

## 2. Elenca i progetti Stubwise

Chiama il tool MCP **`list_projects`** per ottenere l'elenco dei progetti
disponibili sull'istanza Stubwise (nome + slug).

Se il tool restituisce un errore di configurazione (token mancante, istanza non
raggiungibile), fermati e spiega all'utente cosa manca: serve un Personal
Access Token in `STUBWISE_TOKEN` e, se l'istanza non è su
`http://localhost:3000`, l'URL in `STUBWISE_URL`.

## 3. Chiedi l'abbinamento repo → progetto

Per OGNI radice git trovata, chiedi all'utente a quale progetto Stubwise
collegarla, mostrando la lista di slug disponibili.

Ricorda queste regole:

- Un progetto Stubwise può avere PIÙ repository collegate.
- Repository diverse possono puntare a progetti diversi OPPURE allo stesso
  progetto: non forzare un abbinamento 1-a-1.
- Se c'è una sola repo e un solo progetto plausibile, proponilo comunque e
  attendi conferma prima di scrivere.

## 4. Gestisci il caso "già collegato"

Prima di scrivere, controlla se nella radice esiste già un `.stubwise.json`.
Se esiste:

- Mostrane il contenuto attuale (lo slug già collegato).
- Chiedi all'utente se vuole sovrascriverlo con il nuovo progetto.
- Se l'utente NON vuole sovrascrivere, lascia il file invariato e passa alla
  radice successiva.

## 5. Scrivi e committa

Per ogni radice confermata:

1. Scrivi `.stubwise.json` nella radice della repo con il contenuto
   `{ "project": "<slug>" }` (JSON valido, con newline finale).
2. Fai il commit del file NELLA repo corrispondente:

   ```bash
   git -C <radice> add .stubwise.json
   git -C <radice> commit -m "chore: collega il repo al progetto Stubwise <slug>"
   ```

Al termine, riepiloga all'utente quali repo hai collegato a quali progetti e
ricordagli che d'ora in poi la skill `stubwise` userà quel progetto come default
per backlog e ticket in quella repo.
