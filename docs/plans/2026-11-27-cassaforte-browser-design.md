# La cassaforte nella nuova app nel browser (`/app`) — nota di design

> Stato: **in revisione di sicurezza**, 27 nov 2026 (94). C1, C2, C4 e C5
> accettate come raccomandate da 46; C3 decisa dal maintainer (VA-Q3). Il codice
> si scrive dopo le workspace. Decisione del maintainer: la cassaforte si apre
> ANCHE nella nuova app nel browser, non solo sul Mac. Sblocco con la passkey,
> mostra, copia, crea, condividi e conferma direttamente da `/app`, con lo
> sblocco e la decifratura che oggi ha il web vecchio. Stesso indirizzo vuol
> dire stessa passkey e stessa chiave.
>
> Da leggere insieme a:
> - `docs/invariants/vault.md` (le invarianti; i numeri di riga sotto si
>   riferiscono a quel file);
> - la shape `apps/desktop/.impeccable/shape/vault.md`;
> - `docs/plans/2026-11-24-cassaforte-desktop-design.md` (il percorso del Mac).

## 1. Oggi

- **Il web vecchio** (`apps/web`) fa tutto nel browser, con `@stubwise/vault-crypto`
  (solo WebCrypto: ECDH P-256, HKDF-SHA-256, AES-256-GCM, nessuna
  dipendenza):
  - lo sblocco è una riconferma con passkey ed estensione **PRF**
    (`lib/vault/unlock.ts`). `purpose: "vault"` sulle opzioni, il risultato
    PRF tolto dalla verifica e poi azzerato. HKDF(PRF, "unlock") apre la
    chiave privata della persona, sigillata sul server per passkey;
  - la chiave vive **solo in memoria**: un `CryptoKey` non estraibile nello
    stato di `VaultProvider`, senza storage. Si perde con la chiusura della
    scheda, il ricaricamento, «Lock» e il logout;
  - si chiude da sola dopo **15 minuti** senza interazione (`idle.ts`:
    pointerdown, keydown, wheel, touchstart, scroll; il solo movimento del
    mouse non conta);
  - **Show** tiene la password nello stato del componente e la nasconde dopo
    30 s, alla chiusura e allo smontaggio. Una password che arriva dopo la
    chiusura si scarta (invariante, riga 228);
  - **Copy** usa `navigator.clipboard` e svuota gli appunti dopo 30 s, se
    contengono ancora la password o se non si possono leggere (Firefox);
  - **crea, cambia, condividi, conferma, recupero** stanno in
    `lib/vault/credentials.ts` e nelle pagine `vault-*`, con l'`actorProof`
    dove l'invariante lo vuole (riga 108).
- **La nuova app sul Mac** tiene la chiave nel MAIN (`vaultLock.ts`) e la apre
  con il Secure Enclave e Touch ID. L'associazione del Mac nasce da uno sblocco
  con passkey nel browser (`/vault-pair`).
- **La nuova app nel browser** (`/app`) non ha il ponte del main: `getVaultStatus`
  risponde `unsupported`, «New credential» è nascosto, e la barra porta al web
  vecchio (`openVaultInBrowser`).

## 2. La proposta in una riga

**Portare nel renderer della build web il percorso del web vecchio, così com'è**
(stessa crittografia, stesse rotte `browserOnly` con il cookie di sessione,
stesso ciclo di vita della chiave). Il percorso del Mac non cambia. Non nasce
un terzo meccanismo: l'invariante della riga 232 («lo sblocco è una riconferma
con passkey e PRF; il sigillo del Mac è l'unico secondo meccanismo») resta
vera così com'è.

## 3. Cosa si porta da `apps/web`

| Da `apps/web` | Nel renderer (`apps/desktop/src/renderer/`) | Note |
|---|---|---|
| `lib/vault/unlock.ts` (`assertWithPrf`, `openPrivateKey`, prima chiave / `recreate`, `resealPrivateKey`, `sealForDevice`) | `data/backend/real/vaultBrowser/unlock.ts` | Stesse rotte: `reauth/passkey/options` con `purpose:"vault"`, `verify` senza PRF, `POST /api/vault/keys`. Il PRF si azzera dopo l'uso. |
| `lib/vault/credentials.ts` (reveal, writeEncrypted/encryptForRecipients, shareEncrypted, proveKey, rewrapForPerson, recupero) | `data/backend/real/vaultBrowser/credentials.ts` | La logica è la stessa; cambiano solo le firme, quelle del livello dati del prototipo (`data/vault/types.ts`). |
| `lib/vault/vault-context.tsx` (la chiave in memoria) | `data/backend/real/vaultBrowser/key.ts` (stato di modulo, vedi §4) | Non nello stato React: le letture del livello dati ne hanno bisogno fuori dai componenti. |
| `lib/vault/idle.ts` (15 min) | `vaultBrowser/idle.ts` | Vedi §5. |
| `reveal-button.tsx`, `copyWithAutoClear` | le pagine esistenti della Vault, che chiamano il livello dati | La UI resta quella della shape; cambia solo dove arriva la richiesta. |
| `pending-access.tsx`, `readers-panel.tsx`, `credential-form.tsx` | le pagine esistenti della Vault | Già disegnate per il Mac. |
| `vault-recovery.tsx`, attivazione, creare/ricreare la chiave, `/vault-pair` | **seconda fase** (§8) | Oggi la shape li lascia nel browser (righe 353-356), cioè nel web vecchio. Per ritirarlo vanno portati anche loro. |

- **Le rotte di HTTP.** `packages/api-client/src/endpoints/vault.ts` (22-28)
  esclude apposta create, reveal, share e confirm: «nel main del desktop (e
  nel browser)». Le chiamate della build web stanno quindi in
  `vaultBrowser/http.ts`, sopra il `transport` del renderer (stessa origine,
  cookie di sessione), e non nell'api-client. Proposta: il commento
  dell'api-client resta vero; il «browser» ora è anche `/app`.
- **Il confine fra le build** sta in `vite.backend.ts`. `@backend/vault` (o
  il punto di scelta già usato da `vaultDesktop.ts`) risolve:
  - nella build Electron: il ponte del main (`window.stubwise.vault`), com'è
    oggi;
  - nella build web: `vaultBrowser/`;
  - nel prototipo: i dati finti.

  Un test d'architettura (sul modello di `architecture.secrets.test.ts`)
  impedisce che `vaultBrowser/` entri nella build Electron e che il ponte entri
  nella build web.
- **`apiProxy.ts`** (main, 62-73) continua a rifiutare al renderer Electron
  `/api/vault/*` e `/credentials/*/reveal`. Nella build web non c'è proxy: il
  browser parla col server come il web vecchio.

## 4. Dove vive la chiave nel browser

- **Solo in memoria, nella scheda.** Un `CryptoKey` non estraibile
  (`openPrivateKey` lo restituisce così), in una variabile di modulo di
  `vaultBrowser/key.ts`. Mai in `localStorage`, `sessionStorage`, IndexedDB,
  nello stato persistito di React Query, in un Service Worker o in un log.
- **La chiave si butta in questi casi:**
  - «Lock»;
  - 15 minuti senza interazione (§5);
  - il logout e la scadenza della sessione (il primo `401`);
  - un cambio di persona;
  - la chiusura o il ricaricamento della scheda;
  - un `reset` dello stato del renderer.

  Chi la usa la chiede a `key.ts` ogni volta e non ne tiene copie.
- **La cache delle query.** Le password in chiaro non entrano MAI in React
  Query. La lettura che le decifra (`revealPassword`) è una funzione, non una
  query; il valore sta nello stato del componente che lo mostra, come nel web
  vecchio. Nella cache entrano solo i metadati, già oggi non cifrati.
- **Le schede.** Ogni scheda ha la sua chiave e il suo sblocco, come nel web
  vecchio: niente `BroadcastChannel` per passarla, perché una chiave che si
  sposta è una chiave che si può intercettare. Una scheda nuova chiede di
  nuovo la passkey.
- **Stessa passkey e stessa chiave.** `/app` sta sullo stesso dominio del web
  vecchio, quindi:
  - l'`rpId` della passkey è lo stesso;
  - il sigillo della chiave privata (per passkey, sul server) è lo stesso;
  - una persona che ha già attivato la cassaforte nel web vecchio la apre in
    `/app` senza rifare niente, e viceversa.

  Le copie delle credenziali non cambiano.

## 5. La chiusura dopo 15 minuti

- **Stesso tempo e stessa regola del web vecchio:** 15 minuti senza
  **interazione** con la pagina (pointerdown, keydown, wheel, touchstart,
  scroll; il movimento del mouse no). Il timer riparte a ogni interazione;
  scaduto, la chiave si butta, le password mostrate si nascondono, la barra
  torna «Locked».
- **La scheda nascosta.** Il timer continua anche con la scheda in secondo
  piano: si misura con l'ora di parete, non con `setTimeout` soltanto.
  Tornando su una scheda nascosta da oltre 15 minuti, la cassaforte è già
  chiusa (si controlla a `visibilitychange`).
- **La differenza col Mac, da dire.** Sul Mac «senza uso» conta gli usi della
  CHIAVE (`vaultLock.ts`); nel browser conta l'interazione con la pagina. La
  frase della barra «closes after 15 minutes without use» vale per entrambe
  le build, ma la regola è diversa. Proposta: lasciarle diverse, perché il
  web vecchio è il riferimento della build web e il Mac ha già il suo.
  → **Domanda C1** per la revisione.

## 6. Gli appunti, Show e Copy

- **Copy:** `navigator.clipboard.writeText` e, dopo 30 s, si svuota se gli
  appunti contengono ancora la password; se il browser non li lascia leggere
  (Firefox), si svuota comunque. È il `copyWithAutoClear` del web vecchio.
  Nel browser non esistono i tipi «Concealed/Transient» del Mac: i gestori
  degli appunti del sistema possono tenerne una copia. Lo dice una riga sotto
  il bottone, solo nella build web: «Your system's clipboard history may keep
  it.» → **Domanda C2**.
- **Show:** la password resta nello stato del componente e **resta visibile
  finché non si preme Hide**, in tutte e due le build (decisione del
  maintainer, VA-Q3 della shape: «No, resta visibile»). Qui la nuova app NON
  segue il web vecchio, che la nasconde dopo 30 s. Sparisce comunque con
  «Lock», con la chiusura dopo 15 minuti e smontando il componente. Una
  password che arriva dopo la chiusura si scarta (invariante, riga 228). La
  riga 57 della shape, che diceva 30 s, è corretta.
- **Show e Copy a cassaforte chiusa:** aprono il dialogo della passkey e poi
  fanno l'azione (`useWithUnlockedVault`), come sul Mac col Touch ID (VA 4).

## 7. Il rapporto con il percorso del Mac

| | App Mac (Electron) | Nuova app nel browser (`/app`) |
|---|---|---|
| Dove vive la chiave | main, `CryptoKey` non estraibile | scheda, `CryptoKey` non estraibile |
| Sblocco | Secure Enclave + Touch ID (sigillo del Mac) | passkey con PRF (come il web vecchio) |
| Rotte | `desktopVault` / `desktopOnly` / `desktopRead`, col PAT del desktop | `browserOnly`, col cookie di sessione |
| `via` nel registro (`reveal`) | `desktop` | `browser` |
| Chiusura | 15 min senza uso della chiave, sospensione, blocco schermo, uscita | 15 min senza interazione, logout, chiusura della scheda |
| Appunti | Concealed/Transient, svuotati dopo 30 s | `navigator.clipboard`, svuotati dopo 30 s |
| Associare un Mac | — | il browser sigilla la chiave per il Mac (`/vault-pair`), oggi nel web vecchio, poi in `/app` (fase 2) |

- Le due build condividono la UI (le pagine della Vault) e il livello dati
  (`data/vault/types.ts`). Cambiano l'adattatore e gli stati della barra.
- **La barra nella build web** non ha gli stati del Mac (Touch ID, «Pair this
  Mac», «revoked»), ma i suoi:
  - **«Locked» · Open with passkey;**
  - **«Open» · closes after 15 minutes without use** · Lock;
  - **«This passkey can't open the vault»**, per una passkey senza PRF: il web
    vecchio risponde `unsupported` e non manda niente al server. La barra
    propone di aggiungere una passkey che lo supporti, dalle Preferenze →
    Security;
  - **«Not activated yet»**, che porta all'attivazione (fase 2; fino ad
    allora, al web vecchio).

  `VaultBarState` guadagna questi stati (oggi non c'è «chiusa: apri con la
  passkey»).
- **Lo stato `unsupported` della build web scompare.** Resta solo per un
  browser senza WebAuthn o senza PRF, e lo dice.

## 8. Le fasi

1. **Fase 1, l'uso di ogni giorno:** sblocco con passkey, Show, Copy, crea,
   cambia la password, condividi e togli (`actorProof`), conferma e rifiuta
   gli accessi in attesa, chiusura dopo 15 minuti. La barra e la colonna
   (§9). Con questo, chi ha già la cassaforte attiva non apre più il web
   vecchio per usarla.
2. **Fase 2, quello che serve per ritirare il web vecchio:**
   - l'attivazione e la prima chiave, cioè ricreare la chiave;
   - aggiungere una passkey alla cassaforte (`resealPrivateKey`);
   - il recupero col kit, la sua rotazione e il recupero degli altri da parte
     di un full admin;
   - `/vault-pair` per associare un Mac, cioè il sigillo per il dispositivo.

   Ogni pezzo porta con sé le sue invarianti (righe 155, 165, 185).

## 9. La colonna della Vault, come quella del Drive

Oggi la colonna mostra il segnaposto (`column.coming.vault`, fix della #132).
Proposta, come `DriveColumn`:

```
All credentials          12
Waiting for you           2   (solo se ci sono accessi da confermare)

PROJECTS
ACQ                       5
MKX                       4
STW                       3
```

- **All credentials:** tutte le credenziali che chi guarda legge (o aspetta).
- **Waiting for you:** gli accessi da confermare. È la riga che oggi sta in
  testa alla pagina, qui come scorciatoia.
- **PROJECTS:** i progetti fissati e poi quelli con credenziali, col
  conteggio. Ogni voce è il filtro `?project=<CODE>` della pagina, come il
  Drive. Uguale nelle due build; i metadati non servono a sbloccare.

## 10. Sicurezza: cosa cambia e cosa no

- **Superficie.** La chiave privata vive in una pagina che ha tutto il resto
  della nuova app (chat, posta, Docs, il riquadro di Claude). Un XSS in
  qualunque parte di `/app` può usare la chiave a cassaforte aperta, come oggi
  nel web vecchio. Proposte da verificare in revisione:
  - CSP stretta su `/app` (niente inline script, `connect-src 'self'`), come
    il web vecchio o più stretta;
  - nessun HTML di terzi reso senza sanificazione (già regola per mail e
    Docs);
  - nessun `eval` né `new Function` nel bundle (un test sul build).
- **Claude non tocca la chiave.** Il catalogo delle azioni di Claude non ha
  voci della cassaforte (invariante, riga 259: nessuna automazione), e il
  riquadro di Claude non riceve mai password in chiaro. Un test sul sorgente
  vieta che `vaultBrowser/` sia importato da `data/claude/`.
- **Il registro.** `reveal` con `via: "browser"` (riga 29), come il web
  vecchio. Il server distingue già le due vie.
- **Le invarianti non cambiano.** Riga 16: «la chiave privata si apre solo nel
  browser». `/app` è un browser; il Mac resta l'unica eccezione, col suo
  sigillo. Nessuna rotta nuova sul server, nessuna eccezione nuova a
  `browserOnly`.

## 11. Le prove

- **Unità:** l'adattatore `vaultBrowser/` su un `fetch` finto, sul modello di
  `backend/real/*.test.ts`:
  - sblocco con e senza PRF;
  - `reveal` scartato dopo la chiusura;
  - `recipients_changed` riprovato una volta;
  - `actorProof` monouso;
  - chiusura dopo 15 minuti con l'ora finta;
  - appunti svuotati solo se contengono ancora la password.
- **Architettura:**
  - `vaultBrowser/` mai nella build Electron, il ponte mai nella build web;
  - niente storage persistente per la chiave (un test sul sorgente:
    `localStorage`, `sessionStorage` e `indexedDB` vietati in
    `vaultBrowser/`);
  - niente import da `data/claude/`.
- **A mano, una volta, sullo staging:** apri con la passkey, Show, Copy, crea,
  condividi, conferma, la chiusura dopo 15 minuti; la stessa credenziale
  aperta nel web vecchio e in `/app` con la stessa passkey.

## 12. Domande per la revisione di sicurezza e per il maintainer

Ognuna ha la mia raccomandazione per prima.

- **C1. Che cosa vuol dire «senza uso» nel browser?**
  - *Raccomandato*: senza interazione con la pagina, come il web vecchio.
  - *Alternativa*: senza uso della chiave, come il Mac. Così una pagina
    lasciata aperta e usata per altro resta chiusa, ma una lettura lunga di
    una credenziale (Show) chiude la cassaforte mentre la si guarda.
- **C2. Gli appunti nel browser.**
  - *Raccomandato*: `navigator.clipboard` con lo svuotamento dopo 30 s, come
    il web vecchio, più la riga sulla cronologia degli appunti del sistema.
  - *Alternativa*: niente Copy nel browser, solo Show. Più sicuro, ma toglie
    il gesto più usato.
- **C3. Show si nasconde dopo 30 s?** **Decisa** dal maintainer con la
  shape (VA-Q3): no, resta visibile finché Hide, in tutte e due le build;
  sparisce quando la cassaforte si chiude.
- **C4. Una scheda nuova chiede di nuovo la passkey?**
  - *Raccomandato*: sì, ogni scheda ha la sua chiave.
  - *Alternativa*: passarla fra schede con `BroadcastChannel`. La sconsiglio
    (§4).
- **C5. L'ordine delle fasi.**
  - *Raccomandato*: prima la fase 1, poi la 2. Il web vecchio si può ritirare
    solo dopo la fase 2, perché attivazione, recupero e associazione del Mac
    oggi stanno solo lì.
