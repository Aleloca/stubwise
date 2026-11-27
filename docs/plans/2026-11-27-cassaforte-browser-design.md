# La cassaforte nella nuova app nel browser (`/app`) — nota di design

> Stato: **seconda stesura, dopo la revisione di sicurezza** (27 nov 2026,
> 94). Il codice si scrive dopo le workspace. C1–C5 della prima stesura sono
> decise: C3 dal maintainer (VA-Q3), le altre come raccomandate. La revisione
> ha trovato 2 Critical, 7 Important e 7 Minor; ognuno ha qui il suo posto
> (§13). M3 e M4, difetti di oggi, sono corretti a parte
> (`fix/wireframe-svg-noopener`).
>
> Decisione del maintainer: la cassaforte si apre ANCHE nella nuova app nel
> browser, non solo sul Mac (sblocco con passkey, Show, Copy, crea, condividi,
> conferma). Stesso indirizzo vuol dire stessa passkey e stessa chiave.
>
> Leggere con:
> - `docs/invariants/vault.md` (i numeri di riga si riferiscono a quel file);
> - la shape `apps/desktop/.impeccable/shape/vault.md`;
> - `docs/plans/2026-11-24-cassaforte-desktop-design.md`.

## 1. Il modello di minaccia, prima di tutto

**Il confine di sicurezza è l'ORIGINE, non `/app`.** Il web vecchio (`/`),
la nuova app (`/app`) e la guida (`/guide`) stanno sulla stessa origine.
Uno script che gira in una qualunque di queste pagine può:
- aprire `/app` nella stessa origine (iframe o finestra);
- sostituirgli `crypto.subtle`, `navigator.credentials.get` e `fetch` prima
  dello sblocco.

Oggi `/` non ha nessuna CSP: il Caddyfile mette solo HSTS, nosniff,
X-Frame-Options e Referrer-Policy. La prima stesura sbagliava a dire «come il
web vecchio».

**La frase da tenere a mente:** *un XSS sull'origine più un tocco della passkey
valgono il furto permanente della chiave di persona.* Il motivo:
- `PRF_INPUT` è costante (`passkeys.ts:183`, «stubwise/vault/v1/prf»), quindi
  l'uscita PRF di una passkey è un segreto permanente;
- uno script sull'origine può aggiungere `prf.eval` a QUALUNQUE cerimonia
  passkey legittima: il login, una riconferma, lo sblocco;
- con l'uscita PRF e il sigillo (che il server dà a chi ha la sessione) si apre
  la chiave privata: oggi, domani, a cassaforte chiusa;
- **non dipende dal fatto che la cassaforte sia aperta.**

Durante lo sblocco restano poi in memoria JS segreti in chiaro:
- l'uscita PRF;
- la pkcs8 della chiave privata (`assertPairMatches` la importa estraibile);
- i byte grezzi della chiave della voce (`importItemKey` estraibile).

Le password decifrate sono stringhe JS e non si possono azzerare (M2).

**Cosa ne segue.** Portare la cassaforte in `/app` NON aggiunge una superficie
nuova rispetto al web vecchio, perché è la stessa origine. Rende però
inaccettabile lasciarla senza difese. Le difese sotto (§2) sono **condizioni
della fase 1**, non migliorie.

## 2. Le difese (condizioni della fase 1)

1. **CSP su TUTTA l'origine, come header in Caddy** (C1, M1), mai come
   `<meta>`, perché un `<meta>` lo può togliere chi controlla il documento:
   - `script-src 'self'` senza `unsafe-inline` e senza `unsafe-eval`;
   - `connect-src 'self'`;
   - `frame-ancestors 'none'`;
   - `object-src 'none'`;
   - `base-uri 'none'`;
   - su `/`, `/app` e `/guide`.

   Le eccezioni che servono (gli stili di Starlight, i font) vanno scritte una
   per una nel design di Caddy.
2. **COOP `same-origin`** su `/app` (e, se il web vecchio regge, su tutta
   l'origine). Una finestra aperta da altri non tiene un riferimento a `/app`,
   e risolve anche M4 alla radice.
3. **Trusted Types** almeno su `/app`
   (`require-trusted-types-for 'script'`). L'unico punto che scrive HTML è la
   politica che lo ripulisce: SVG degli schizzi (M3) e QR del TOTP.
4. **Le primitive catturate all'avvio del modulo** (C2). `vaultBrowser/`
   salva, al PRIMO import e prima di qualunque altro codice dell'app:
   - `crypto.subtle`;
   - `navigator.credentials.get` e `.create`;
   - `fetch`.

   Poi usa solo quelle copie. Uno script arrivato dopo non le sostituisce più
   per la cassaforte. È un argine, non un muro (chi gira PRIMA vince): per
   questo vengono prima la CSP e i Trusted Types.
5. **Nessun sito non fidato sui sottodomini** dell'istanza: una regola di
   deploy scritta in `docs/operations/` e nel README self-hosted.
6. **Rate limit e avviso sui reveal** (lato server, 54): un numero anomalo di
   `reveal` per sessione si rallenta, e manda un `security.alert` alla persona.
7. **Lo sblocco della cassaforte NON rinnova la riconferma** (I6, lato
   server, 54). Oggi la riconferma con `purpose: "vault"` rinnova
   `secondFactorAt`, quindi per 10 minuti passano senza tocco le rotte con
   `config.reauth`:
   - registrare una passkey;
   - le azioni C di Claude;
   - creare un PAT.

   Lo sblocco deve valere solo per la cassaforte.
8. **Origin e `Sec-Fetch-Site` sulle scritture col cookie** (M5, server):
   difesa in profondità contro un CSRF residuo.
9. **Claude non tocca la cassaforte** (M6): le funzioni `vault.*` vanno nel
   `NEVER` di `neverInCatalog.test.ts`, e `vaultBrowser/` non si importa da
   `data/claude/` (test sul sorgente).
10. **La supply chain del renderer** (M7) è superficie della cassaforte:
    `@simplewebauthn/browser`, `@stubwise/vault-crypto` e ogni dipendenza del
    bundle di `/app`. Il lockfile fissa le versioni, e un aggiornamento di
    quelle due si legge nel diff prima del merge.

### La procedura d'incidente

Dopo un XSS confermato sull'origine, o il sospetto di uno, una passkey va
trattata come compromessa per la cassaforte.
- **Server:** revocare le sessioni; ruotare il sigillo di ogni persona che si
  è autenticata nella finestra sospetta (`recreate`, con una passkey e una
  coppia di chiavi NUOVE); ri-cifrare le copie (lo fa la conferma degli
  accessi in attesa).
- **Persone:**
  - cambiare le password delle credenziali lette nella finestra (il registro
    dei `reveal` dice quali);
  - togliere e ri-registrare le passkey;
  - ruotare il kit di recupero.
- **Dove sta scritta:** la procedura va in `docs/operations/` (voce
  «Cassaforte: incidente sull'origine»), con le query del registro. La
  rotazione di massa è un comando di amministrazione da scrivere nella
  fase 2.

## 3. Cosa si porta da `apps/web`

| Da `apps/web` | Nel renderer | Note |
|---|---|---|
| `lib/vault/unlock.ts` | `data/backend/real/vaultBrowser/unlock.ts` | Stesse rotte; il PRF si azzera subito; la pkcs8 si importa NON estraibile dove la verifica lo consente (§6). |
| `lib/vault/credentials.ts` | `vaultBrowser/credentials.ts` | La chiave della voce si importa non estraibile nel percorso di reveal, e i byte grezzi si azzerano (M2). |
| `lib/vault/vault-context.tsx` | `vaultBrowser/key.ts` (§5) | Uno stato di modulo con un'API piccola, non lo stato di React. |
| `lib/vault/idle.ts` | dentro `key.ts` (§7) | Riscritto: ora di parete, `isTrusted`, niente scroll. |
| `reveal-button.tsx`, `copyWithAutoClear` | le pagine della Vault | La UI resta quella della shape. |
| `pending-access.tsx`, `readers-panel.tsx`, `credential-form.tsx` | le pagine della Vault | Già disegnate. |
| attivazione, recupero, `/vault-pair` | **fase 2** (§10) | Con le regole di I7. |

Le chiamate stanno in `vaultBrowser/http.ts`, sopra il `fetch` CATTURATO
(§2.4) e con stessa origine e cookie, non nell'api-client. L'api-client le
esclude apposta (`endpoints/vault.ts:22-28`).

## 4. La dimensione di build: Electron e web (I1)

Oggi `vite.backend.ts` distingue solo `prototype` e `app`: Electron e web
risolvono gli stessi alias, e la scelta del ponte avviene a runtime su
`window.stubwise`, che uno script può falsare.

- **Una dimensione nuova, `target: electron | web`**, fissata al build
  (`build:app` → electron, `build:web` → web) e letta da `vite.backend.ts`;
- **un alias `@backend/vault`**:
  - `target: electron` → il ponte del main (`vaultDesktop.ts`, come oggi);
  - `target: web` → `vaultBrowser/`;
  - prototipo → i dati finti.

  Nessuna scelta a runtime.
- **Un controllo sui BUNDLE**, come `check-no-seed.mjs`: `check-vault-target.mjs`
  - fallisce se nell'output Electron (`out/`) compaiono i marcatori della
    passkey (`navigator.credentials`, `prf`, i nomi delle rotte di sblocco);
  - fallisce se in `dist-web/` compare `stubwise.vault` (il ponte).

  Gira in `Dockerfile.caddy` e in `package:mac`.
- **`/vault-pair` non esiste nella build Electron** (I7): la rotta si registra
  solo con `target: web`.

## 5. Dove vive la chiave: l'API di `key.ts`

Solo in memoria, nella scheda, come `CryptoKey` non estraibile, in un modulo
con questa API (e nient'altro):

```ts
// vaultBrowser/key.ts
type VaultKeyState =
  | { state: "locked" }
  | { state: "open"; personId: string; sessionId: string; openedAt: number; lastUseAt: number };

/** Apre: tiene la chiave legata a persona + sessione. Riparte il conto dei 15 minuti. */
open(key: CryptoKey, personId: string, sessionId: string): void;

/**
 * La chiave per UN uso (reveal, wrap, unwrap). Controlla la scadenza A OGNI
 * CHIAMATA, a ora di parete; chiusa, scaduta, o con persona/sessione diverse
 * da quelle di adesso: chiude e lancia `vault_locked`. Un uso riparte il conto.
 */
use(personId: string, sessionId: string): CryptoKey;

/** Chiude: butta la chiave, emette `locked`, avvisa le altre schede (§8). */
lock(reason: "user" | "idle" | "logout" | "pagehide" | "session" | "remote"): void;

/** Lo stato per la barra, senza la chiave. */
status(): { state: "locked" } | { state: "open"; closesAt: number };

/** Chi ascolta: la barra, le righe mostrate, la cache delle query (§6). */
subscribe(fn: (s: ReturnType<typeof status>) => void): () => void;
```

- **Persona e sessione:** la chiave vale solo per quella coppia. Un cambio
  dell'una o dell'altra (logout, scadenza, un'altra persona in un'altra
  scheda) la rende inutilizzabile alla prossima `use` (I5).
- **Mai fuori dalla memoria:** niente `localStorage`, `sessionStorage`,
  IndexedDB, Service Worker, cache persistita di React Query o log. Un test sul
  sorgente vieta queste API in `vaultBrowser/`.
- **Stessa passkey, stessa chiave:** stessa origine vuol dire stesso `rpId`,
  stesso sigillo sul server e stesse copie. Chi ha già attivato la cassaforte
  nel web vecchio la apre in `/app` senza rifare niente.

## 6. Show, Copy e lo stato «chiusa» che arriva subito

- **Show resta finché Hide** (VA-Q3, maintainer), in tutte e due le build. In
  più, la password sparisce:
  - quando la cassaforte si chiude, per qualunque motivo;
  - quando la scheda va in secondo piano (`visibilitychange` → hidden);
  - a `pagehide`;
  - smontando il componente.

  Una password che arriva dopo la chiusura si scarta (riga 228).
- **Lo stato «chiusa» arriva alle righe in modo SINCRONO** (I3): `lock()` emette
  e fa `setQueryData` sullo stato della barra e sulle righe mostrate, senza
  aspettare un refetch. Le password in chiaro non entrano MAI in React Query:
  stanno nello stato del componente che le mostra, che ascolta `subscribe`.
- **Copy** (I4): `navigator.clipboard.writeText`, e dopo 30 s si svuota se gli
  appunti contengono ancora la password (o se non si possono leggere). Senza
  fuoco, `writeText("")` fallisce in silenzio, quindi:
  - lo svuotamento si RIPROVA a `focus` e a `visibilitychange` → visible
    finché non riesce;
  - si svuota anche alla chiusura della cassaforte;
  - la frase sotto il bottone è onesta: «Clears from your clipboard in 30
    seconds when this tab is in front. Your system's clipboard history may
    keep it.»
- **La memoria (M2):** la chiave della voce si importa non estraibile nel
  percorso di reveal, e i byte grezzi si azzerano subito. La pkcs8 durante lo
  sblocco: dove `assertPairMatches` ne ha bisogno estraibile, si importa,
  si confronta e si azzera nello stesso tick; la chiave tenuta da `key.ts` è
  sempre un'importazione NON estraibile a parte. Le stringhe delle password
  non si possono azzerare in JS: è un limite scritto (§12).

## 7. La chiusura dopo 15 minuti (I2)

- **Che cosa conta come uso (C1 decisa):** l'interazione con la pagina, cioè
  solo eventi `isTrusted` (pointerdown, keydown, touchstart, wheel). NON lo
  scroll, che può essere programmatico, e non il movimento del mouse. Ogni
  `use()` della chiave conta anch'esso.
- **A ora di parete, non a timer:**
  - `key.ts` controlla la scadenza a ogni `use()`, e a `visibilitychange`,
    `focus` e `pageshow`;
  - il `setTimeout` serve solo a chiudere in tempo una pagina in primo piano;
  - se il Mac si sospende o la scheda finisce nel bfcache, al ritorno la
    scadenza è già passata e la cassaforte si chiude prima di qualunque uso.
- **`pagehide` chiude la cassaforte:** una pagina che entra nel bfcache (da
  «Open in web» e poi «Indietro») torna chiusa.
- **`Cache-Control: no-store` sull'`index.html` di `/app`** (header in
  Caddy): niente pagina servita dalla cache con uno stato vecchio.
- **Limite da dire:** nel browser lo stop del computer e il blocco dello
  schermo NON chiudono la cassaforte all'istante, come invece fa il Mac. La
  chiudono al ritorno, se sono passati 15 minuti. Lo dice la barra solo nella
  build web, e lo dice la tabella del §9.

## 8. Più schede (I5, C4 decisa)

- Ogni scheda ha la sua chiave e il suo sblocco (C4): la chiave non si passa
  MAI fra schede.
- Un `BroadcastChannel("stubwise-vault")` porta solo SEGNALI: `locked` e
  `logout`, con `personId`. Ricevuto, la scheda chiude la sua cassaforte
  (`lock("remote")`). «Lock» in una scheda chiude tutte; un logout in una
  scheda chiude tutte.

## 9. Il rapporto con il percorso del Mac

| | App Mac (Electron) | Nuova app nel browser (`/app`) |
|---|---|---|
| Dove vive la chiave | main, `CryptoKey` non estraibile | scheda, `CryptoKey` non estraibile (`key.ts`) |
| Sblocco | Secure Enclave + Touch ID | passkey con PRF |
| Rotte | `desktopVault` / `desktopOnly` / `desktopRead`, PAT del desktop | `browserOnly`, cookie di sessione |
| `via` di `reveal` | `desktop` | `browser` |
| Chiusura | 15 min senza uso, sospensione, blocco schermo, uscita | 15 min senza interazione o uso (ora di parete), `pagehide`, logout, segnale da un'altra scheda; sospensione e blocco schermo solo al ritorno |
| Appunti | Concealed/Transient, 30 s | `navigator.clipboard`, 30 s con riprova al fuoco |
| Show | finché Hide; sparisce alla chiusura | finché Hide; sparisce alla chiusura, in secondo piano, a `pagehide` |
| Bundle | mai i marcatori della passkey (§4) | mai il ponte `stubwise.vault` (§4) |

- La barra della build web ha i suoi stati:
  - **Locked** · Open with passkey;
  - **Open** · closes after 15 minutes without use · Lock;
  - **This passkey can't open the vault**, per una passkey senza PRF;
  - **Not activated yet**, cioè la fase 2.

  `VaultBarState` guadagna questi stati.

## 10. Le fasi (C5 decisa)

1. **Fase 1, l'uso di ogni giorno:** sblocco, Show, Copy, crea, cambia,
   condividi e togli, conferma e rifiuta. Più la barra e la colonna (§11).
   **Parte solo con le difese del §2 al loro posto**: almeno la CSP e COOP
   (Caddy), il server che non rinnova la riconferma (I6), la dimensione di
   build col suo controllo (§4) e le primitive catturate.
2. **Fase 2, quello che serve per ritirare il web vecchio** (I7):
   - attivazione e prima chiave, aggiungere una passkey, recupero col kit e
     la sua rotazione: in una **pagina minima dedicata** di `/app`, con la sua
     CSP, senza la chat, la posta, il riquadro di Claude né altro codice
     dell'app. Il kit mai negli appunti, mai in React Query, mai in
     `#print-root`, mai nel contesto di Claude;
   - `/vault-pair`, solo nella build web (§4);
   - un sigillo NUOVO lascia traccia: oggi `vault.ts:417` registra solo
     `replaced`. Serve un evento `sealed` nel registro di sicurezza della
     persona e un `security.alert` («A passkey can now open your vault»),
     lato server.

## 11. La colonna della Vault, come quella del Drive

```
All credentials          12
Waiting for you           2   (solo se ci sono accessi da confermare)

PROJECTS
ACQ                       5
MKX                       4
```

Ogni voce dei progetti è il filtro `?project=<CODE>`. È uguale nelle due
build e non serve sbloccare: sono metadati.

## 12. Limiti dichiarati

- Un XSS sull'origine più un tocco della passkey valgono il furto permanente
  della chiave di persona (§1). Le difese riducono la probabilità, non le
  conseguenze; la procedura d'incidente (§2) è la risposta.
- Le password decifrate sono stringhe JS: non si azzerano, restano finché il
  garbage collector non le toglie.
- Nel browser lo stop e il blocco dello schermo chiudono solo al ritorno (§7).
- La cronologia degli appunti del sistema può tenere una copia (§6).
- L'HKDF della copia non lega la chiave pubblica del destinatario (riga 222,
  accettato).

## 13. Dove sta ogni punto della revisione

| Punto | Dove | Chi |
|---|---|---|
| C1 CSP su tutta l'origine, COOP, Trusted Types | §1, §2.1–2.3 | Caddy: 54, se il maintainer è d'accordo |
| C2 PRF costante, segreti in memoria, procedura d'incidente | §1, §2.4–2.6, §2 procedura, §6 | 94 (renderer), 54 (rate limit, avviso) |
| I1 dimensione di build e controllo dei bundle | §4 | 94 |
| I2 15 minuti a ora di parete, `isTrusted`, bfcache, no-store | §7 | 94; no-store in Caddy |
| I3 Show nascosto in secondo piano e a `pagehide`, stato sincrono | §6 | 94 |
| I4 appunti senza fuoco | §6 | 94 |
| I5 più schede: solo segnali | §5, §8 | 94 |
| I6 lo sblocco non rinnova la riconferma | §2.7 | 54 |
| I7 fase 2: traccia del sigillo, pagina minima, `/vault-pair` solo web | §4, §10 | 94 + 54 |
| M1 CSP come header, test sugli header | §2.1, §14 | 54 |
| M2 stringhe JS, chiave della voce non estraibile | §6, §12 | 94 |
| M3 SVG degli schizzi | corretto in `fix/wireframe-svg-noopener` | 94 (fatto) |
| M4 `window.open` senza noopener | corretto lì; COOP alla radice | 94 (fatto) |
| M5 Origin / Sec-Fetch-Site | §2.8 | 54 |
| M6 `vault.*` nel NEVER | §2.9 | 94 |
| M7 supply chain del renderer | §2.10 | — |

## 14. Le prove

- **Unità** (`vaultBrowser/` su un `fetch` finto):
  - sblocco con e senza PRF, e PRF azzerato;
  - `use()` che chiude dopo 15 minuti a ora di parete senza nessun timer;
  - `use()` con persona o sessione diverse che lancia e chiude;
  - eventi non `isTrusted` e lo scroll che NON allungano la vita;
  - `pagehide` che chiude;
  - il segnale di un'altra scheda che chiude;
  - `reveal` scartato dopo la chiusura;
  - `recipients_changed` riprovato una volta;
  - `actorProof` monouso;
  - lo svuotamento degli appunti riprovato al fuoco.
- **Architettura e bundle:**
  - `check-vault-target.mjs` (§4) in CI e nei due build;
  - niente storage persistente in `vaultBrowser/`;
  - niente import da `data/claude/`;
  - `vault.*` nel NEVER del catalogo.
- **Header** (M1): un test sul Caddyfile o sugli header serviti in CI (CSP,
  COOP, `no-store` su `/app/index.html`) su `/`, `/app` e `/guide`.
- **A mano, sullo staging, una volta prima del rilascio:**
  - apri, Show, Copy, crea, condividi, conferma; la stessa credenziale nel web
    vecchio e in `/app` con la stessa passkey;
  - **bfcache:** cassaforte aperta → «Open in web» → «Indietro»: torna
    chiusa;
  - **stop del computer oltre 15 minuti:** al risveglio la cassaforte è chiusa
    prima di qualunque uso, e una password mostrata non c'è più;
  - **chat dal vivo oltre 15 minuti** (aggiornamenti che arrivano senza che
    nessuno tocchi la pagina): la cassaforte si chiude comunque;
  - **logout in un'altra scheda:** questa scheda chiude la cassaforte e
    nasconde le password;
  - **Copy e poi un'altra app:** dopo 30 s, tornando sulla scheda, gli appunti
    si svuotano (e la frase sotto il bottone dice proprio questo);
  - una passkey senza PRF: la barra lo dice, e al server non arriva niente.
