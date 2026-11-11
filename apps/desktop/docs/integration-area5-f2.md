# Integrazione area 5 «Docs e Drive», fetta 2: il Drive dei caricati nel desktop — parità col prototipo (11 nov 2026)

Cosa del Drive del prototipo (`data/drive/{reads,writes}.ts`, `data/model.ts`)
arriva sul server vero. Design: `docs/plans/2026-11-11-integrazione-area5-docs-design.md`;
invariante: `docs/invariants/drive.md`. Le rotte, gli schemi
(`@stubwise/shared` `schemas/drive.ts`) e `client.drive` sono di stubwise-72
(F2.1–F2.4); qui il renderer e il main.

## Renderer e main (stubwise-94)

Accesi nella build app: la destinazione `drive`, la sezione `drive` del
progetto e la feature `drive` (`data/integration.ts`). Google resta spento
(`google`, area 6). Il livello dati è `data/backend/real/drive.ts`.

| Voce del prototipo | Build app | Test |
|---|---|---|
| `listDriveFiles` (progetto o tutti i progetti, tipo, chi l'ha aggiunto, ordinamento) | `client.drive.list`/`listAll`; 403/404 è un elenco vuoto; `projectCode` dai progetti se un server più vecchio non lo dà; nascosti e fonte Google: vuoto, senza chiamate | `real/drive.test.ts` |
| `getDriveFile` (per id o per codice `?file=AUD-F3`), aperture totali e storico con `drive.history` | `client.drive.resolveCode` poi `get`; non visibile è `null`; un riferimento che non è né id né codice non chiama | idem |
| `searchDrive` | `list`/`listAll` con `q` (nome e codice), da 2 caratteri; nessun passaggio (`passage: null`) e nessun file fuori dai progetti | idem |
| `uploadFiles` con l'avanzamento | desktop: `files.register` (il main apre il file una volta con `O_NOFOLLOW` e `fstat`, dà un token monouso) e `api.upload` (streaming dal descrittore, Content-Length esatta, bearer); web: XHR col FormData e il cookie. Oltre 100 MB `too_large` senza partire; `storage_not_configured` è `invalid: storage_off`; annullato `canceled` | `real/drive.test.ts`, `src/main/apiUpload.test.ts` |
| La riga in caricamento (barra, «Cancel») | barra vera; «Cancel» e lo smontaggio della pagina (cambio di persona compreso) annullano il caricamento | `pages/drive/UploadZone.test.tsx` |
| `deleteDriveFile` | `client.drive.remove`; 403 `forbidden`, 404 `not_found` | `real/drive.test.ts` |
| `recordOpen` (anteprima, download) | è il gesto stesso: il server conta l'apertura a `/download` e `/preview` (una per persona ogni 30′) | `real/drive.test.ts`, `pages/drive/FilePreview.test.tsx` |
| «Save to Drive» dall'allegato della Chat | `drive.saveAttachmentToDrive` → `client.drive.saveFromChat`; in un canale di progetto il progetto non si manda | `real/drive.test.ts` |
| Citazioni `drive` (gettone con tipo, aperture, progetto; dettaglio nel Drive) | dalla citazione del server (`citations[].drive`); il riferimento ricorda il codice (R-H5); un file scelto con «#» parte fra le citazioni | `real/chat.test.ts` |
| «#» propone i file | `client.drive.listAll({ q })` per nome e codice, dopo task, progetti e pagine | `real/claudeChat.test.ts` |
| «Cite in Chat» / «Share to…» | invariato: il codice va nella bozza, il server lo cita | — |
| Senza Google | niente «Add from Google Drive», «Link a Google folder», filtro della fonte, nascosti, invito a collegare; le cartelle collegate non si leggono | `pages/ComingSoon.test.tsx` |

### Differenze dichiarate

- **Anteprima** (decisione dell'orchestratrice, 11 nov 2026): sul desktop è un
  salvataggio dal main (`api:download`, sul solo percorso
  `/api/drive/files/<uuid>/download`), mai un `shell.openExternal` dell'URL
  firmato; sul web è la rotta `preview` in una scheda nuova (inline solo per
  pdf, immagini e testo, e solo se lo storage sta su un'altra origine;
  altrimenti si scarica). Nella build app non c'è la sovrapposizione Quick
  Look del prototipo (né ←/→ fra i file), né la miniatura nel dettaglio.
- **`counted`** di `recordOpen` non si sa (lo decide il server): vero se il file
  si è aperto, falso per un salvataggio annullato.
- **Contenuto** (F3): nessun testo estratto, riassunto, OCR, «Reading the
  content…» né «Riprova»; la riga dice «nessun riassunto». La ricerca è per
  nome e codice, senza passaggio.
- **Google** (area 6): spento per intero, compresi i file fuori dai progetti
  nella ricerca e «Apri in Google Drive».
- **`modifiedAt`** è la data di caricamento; un file di una persona eliminata
  (`addedById` null) non ha autore.
- **«#»** cerca i file da 2 caratteri (come la ricerca del Drive), non da 1.
- **Web, sessione scaduta durante un caricamento**: il caricamento fallisce
  («Upload failed»); la sessione si chiude alla richiesta successiva.
- Più file scelti insieme: al più 3 caricamenti alla volta per finestra (orchestratrice), gli altri in coda (la riga resta a zero finché non parte; il main non apre il file prima); ciascuno col suo esito, una riga per file come nel prototipo.
