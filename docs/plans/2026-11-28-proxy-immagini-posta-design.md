# Le immagini delle email passano dal nostro server — design

> 28 nov 2026, 72. Decisione del maintainer (via 46): nella nuova app
> «Show images» deve funzionare, le immagini passano da un proxy del NOSTRO
> server e la CSP della pagina resta stretta. Pezzo sensibile: questo
> design va approvato prima del codice. Le scelte da confermare sono
> **[PI n]**, in fondo.

## 1. Il problema, misurato

- La nuova app nel browser (`/app`) ha nel `<meta>` la CSP del renderer
  (`PRODUCTION_CSP` di `apps/desktop/src/main/security.ts`, iniettata da
  `vite.app-web.config.ts`): `img-src 'self' data:`.
- L'email si rende in `UntrustedHtmlFrame` (`apps/desktop/src/renderer/pages/
  mail/UntrustedHtmlFrame.tsx`), cioè un `<iframe sandbox="" srcdoc>`. Un
  documento `srcdoc` **eredita** la CSP del genitore, e la sua CSP nel
  `<meta>` può solo stringere, mai allargare: il `https: http:` che
  «Show images» aggiunge non serve a niente. Le immagini remote non
  caricano mai.
- **L'app Mac ha lo stesso difetto**, per la stessa ragione (stessa CSP,
  dal `<meta>` e dall'header di `app://stubwise`). In più il renderer non ha
  il token, che sta nel main.
- Il web vecchio non ha CSP: con «Show images» il browser di chi legge
  chiede le immagini **direttamente al mittente**, che vede IP, User-Agent,
  lingua e ora di chi apre.

Un fatto che semplifica tutto: il server consegna l'HTML già passato da
`sanitizeEmailHtml` (`packages/google/src/gmail.ts`, allowlist), che lascia
**un solo vettore di immagine remota**: `<img data-src="http(s)://…">`.
Niente `src`, `srcset`, `background`, `<style>`, `url()` nei CSS, SVG o
`<image>`. Il proxy deve coprire solo quello.

## 2. La forma: un'immagine si chiede per POSIZIONE, mai per URL

```
GET /api/me/mail/:source/:id/images/:n      (n = 0, 1, 2… in ordine di documento)
```

- **Il client non manda mai un URL.** Il server rilegge il corpo del
  messaggio, lo passa da `sanitizeEmailHtml` (la STESSA funzione della
  risposta di `/original`), elenca i `data-src` in ordine di documento e
  prende l'`n`-esimo. Un URL che non compare in quella email non è
  raggiungibile per costruzione: non è un proxy aperto. Non servono token
  firmati, né una chiave da custodire o ruotare. **[PI 1]**
- **Chi può chiamarla** è chi può leggere quell'email: la rotta risolve il
  messaggio con `resolveEmailMessage(db, userId, source, id)`, la stessa di
  `/original`, che cerca solo nelle caselle di chi chiama
  (`googleAccounts.userId`). È la regola `mailbox_owner`, che **non include
  MAI gli admin** (invariante in `docs/invariants/mail-calendar.md`). Un
  messaggio di un altro, o un `n` fuori dall'elenco, risponde 404
  `not_found`, uguale a un messaggio che non esiste.
- Serve una **sessione** (`config.access: { kind: "user" }`), come il resto
  di `/api/me/mail`. Il PAT `desktop` vale come per `/original`, perché è il
  percorso dell'app Mac (§6). **[PI 2]**
- **Il corpo si legge solo dalla cache** (`email_bodies`). «Show images»
  esiste solo dopo che `/original` ha risposto, e `/original` scrive la
  cache: la rotta delle immagini non parla mai con Gmail. Senza cache: 404.
- Per far combaciare le posizioni, `/original` aggiunge a ogni
  `<img data-src>` un `data-image="n"`. È un passo DOPO il sanificatore
  (`numberRemoteImages`, puro, testato), non una modifica dell'allowlist, e
  la rotta delle immagini numera con la stessa funzione. Un'immagine senza
  `data-image` (un client che parla con un server di prima) resta bloccata.

## 3. La richiesta verso il mittente: SSRF

Un modulo a sé, `apps/server/src/mail-images/fetch.ts`, che non fa altro e
non accetta opzioni dal chiamante:

- **Schema e porta**: solo `https:`, porta 443 (o assente). Rifiutati
  `http:`, le credenziali nell'URL (`user:pass@`) e le porte diverse.
  **[PI 3]**
- **Indirizzi**: la risoluzione DNS la fa il modulo, con `dns.lookup(host,
  { all: true })`. Se **anche uno solo** degli indirizzi è vietato,
  rifiuta. La connessione va all'indirizzo già controllato (`lookup`
  personalizzato di `https.request`): il controllo e la connessione non
  possono divergere (DNS rebinding). Un host che è già un IP si controlla
  allo stesso modo.
- **Vietati**:
  - IPv4: `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`,
    `169.254/16` (link-local e metadata, `169.254.169.254`), `172.16/12`,
    `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`,
    `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`;
  - IPv6: `::`, `::1`, `fc00::/7` (compreso `fd00:ec2::254`, metadata AWS),
    `fe80::/10`, `ff00::/8`, `2001:db8::/32`;
  - `::ffff:0:0/96` e `64:ff9b::/96` si controllano sull'IPv4 che
    contengono;
  - i nomi `localhost` e i suffissi `.localhost`, `.local`, `.internal`. I
    nomi dei servizi del compose (`postgres`, `ollama`, `graphify`, …)
    risolvono a IP privati, e cadono comunque nella regola degli indirizzi.
- **Redirect**: si seguono a mano (`redirect` mai automatico), **al più
  3**. Ogni `Location` si risolve in assoluto e ripassa da TUTTI i
  controlli: schema, porta, DNS, indirizzi.
- **Tempi e dimensioni**: connessione entro 3 s, risposta intera entro 8 s,
  **al più 5 MB**. Un `Content-Length` più grande rifiuta subito, e il corpo
  si legge a flusso e si interrompe al tetto. **[PI 4]**
- **Nessun dettaglio verso il client**: qualunque rifiuto (indirizzo
  vietato, timeout, non immagine, 404 del mittente) risponde lo stesso 422
  `image_unavailable`. Il server non deve diventare un oracolo che dice
  quali host interni esistono. Nel log vanno solo l'host e il motivo, mai
  l'URL intero, che porta spesso il token di tracciamento del destinatario.

## 4. Cosa si restituisce

- **Solo immagini raster**: `image/png`, `image/jpeg`, `image/gif`,
  `image/webp`, `image/avif`. Il tipo **lo decide il server dai primi
  byte** (magic number), non dal `Content-Type` del mittente: se i due non
  combaciano, o il formato non è in elenco, la risposta è 422.
- **SVG mai**, in nessuna forma: è un documento che può contenere script e
  riferimenti esterni. Un'email con un logo SVG lo mostra come immagine
  mancante. **[PI 5]**
- **Gli header della risposta**: `Content-Type` imposto (quello dedotto dai
  byte), `X-Content-Type-Options: nosniff`, `Content-Security-Policy:
  default-src 'none'; sandbox` (se qualcuno aprisse l'indirizzo come
  pagina), `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy:
  no-referrer`, `Content-Disposition: inline`.

## 5. Privacy verso il mittente

- La richiesta verso il mittente **non porta niente di chi legge**:
  nessun cookie, `Authorization`, `Referer`, `Accept-Language` né header
  inoltrato dal client. Porta solo `Accept: image/*` e un User-Agent
  generico, uguale per tutte le istanze, senza versione né nome
  d'istanza (per esempio `Mozilla/5.0 (compatible; ImageProxy)`). **[PI 6]**
- Il mittente vede l'IP del **server**, non quello di chi legge. Resta vero
  che un pixel di tracciamento sa che l'email è stata aperta quando si preme
  «Show images»: è il motivo per cui le immagini restano spente finché chi
  legge non lo chiede, e quella scelta non cambia.

## 6. Le tre superfici

- **La nuova app nel browser (`/app`)**: con «Show images» il frame, per
  ogni `<img data-image="n">`, chiede i byte con `authedDataUrl` (il fetch
  col cookie dalla pagina, `connect-src 'self'`), li mette in `src` come
  `data:image/…` e il frame si ridisegna. **Si aspettano tutte le immagini
  prima di ridisegnare**, perché ogni ridisegno di un `srcdoc` ricarica il
  documento. La CSP del frame si STRINGE: `img-src data:` sempre, e via
  `https: http:` anche da `style-src`. La CSP di `/app` non cambia.
- **L'app Mac**: lo stesso codice del renderer. `authedDataUrl` passa dal
  main col token (come le immagini dei Docs di prodotto,
  `data/backend/real/productDocs.ts`): il renderer non vede mai né il token
  né l'URL del mittente come risorsa da caricare. Nessuna CSP cambia.
- **Il web vecchio**, finché esiste: **resta com'è**, cioè «Show images»
  carica dal mittente. Passarlo al proxy vorrebbe dire rifare il suo frame:
  un `<img src="/api/…">` dentro un `srcdoc` sandbox senza
  `allow-same-origin` ha un'origine opaca, e il cookie di sessione
  (SameSite) non partirebbe. Il web vecchio sparisce col ritiro. **[PI 7]**
- **Tetti nel client**: al più **50 immagini** per messaggio (oltre, restano
  spente con la frase), 4 richieste insieme, la stessa posizione una volta
  sola. Un'immagine che non arriva resta col suo `alt`.
- Le descrizioni degli eventi del calendario usano lo stesso frame e
  passano anche loro da `sanitizeEmailHtml` (`me-calendar.ts`), ma non da
  `/original` né da `email_bodies`: il proxy per posizione non le copre. Lì
  il bottone **non si mostra** più, invece di promettere immagini che non
  arriveranno. Estenderlo agli eventi (stessa forma, `…/events/:id/images/:n`)
  è un pezzo a parte, se serve. **[PI 8]**

## 7. Cache e rate limit

- **Nessuna cache sul server**: né su disco né in memoria. Le immagini sono
  contenuto di terzi, e chiederle solo a «Show images» le tiene rare. Una
  cache sarebbe una copia di contenuto altrui da governare (retention,
  cancellazione col messaggio). **[PI 9]**
- Nel client: `Cache-Control: private, max-age=3600` sulla risposta (cache
  HTTP del browser, solo per chi l'ha chiesta). Il desktop non tiene niente:
  lo stato di «Show images» non si ricorda, come oggi.
- **Rate limit**: `config.rateLimit` della rotta, **120 richieste al minuto
  per utente** (un messaggio con 50 immagini aperto due volte di fila
  passa). In più, nel modulo di fetch, **al più 8 richieste verso l'esterno
  insieme per tutta l'istanza**, per evitare che il server diventi un
  amplificatore.

## 8. L'invariante del corpo HTML

- **Dove si conserva**: in `email_bodies`, grezzo, come oggi. Questa rotta
  lo **legge** e basta, e lo sanifica a ogni lettura come `/original`.
- **Dove no**: i byte delle immagini non si salvano da nessuna parte (nessuna
  colonna, file o cache del server). Gli URL delle immagini non si salvano a
  parte e non finiscono nei log. `text_excerpt` non si tocca.
- La voce dell'invariante in `docs/invariants/mail-calendar.md` va estesa
  con una riga: «le immagini remote passano dal proxy per posizione, mai
  per URL; i loro byte non si conservano».

## 9. Il catalogo MCP

La rotta restituisce byte, e al modello non servono. Va dichiarata **fuori
dal catalogo MCP**, con la riga nel test di parità che dice perché. È la
stessa scelta degli altri download binari. **[PI 10]**

## 10. Test (rossi prima)

- **`fetch.ts`, unitari, senza rete vera**:
  - ogni intervallo vietato, nelle forme v4, v6, mappata e NAT64;
  - un nome che risolve a un indirizzo pubblico e a uno privato →
    rifiutato;
  - redirect verso un IP privato al secondo salto → rifiutato;
  - 4 redirect → rifiutato;
  - `http:`, porta 8443, `user@` → rifiutati;
  - un corpo oltre 5 MB interrotto a metà;
  - timeout;
  - `Content-Type: image/png` con byte HTML → 422;
  - SVG → 422.
- **La rotta, con Postgres vero e un mittente finto**:
  - `n` giusto → byte e header;
  - `n` fuori dall'elenco → 404;
  - messaggio di un altro utente → 404;
  - **un full admin su un messaggio non suo → 404** (test negativo di
    `mailbox_owner`);
  - nessuna cache → 404;
  - la richiesta verso il mittente non porta cookie né `Authorization` né
    `Referer`, e lo User-Agent è quello generico;
  - il rate limit risponde 429.
- **Il renderer**:
  - «Show images» chiede le posizioni dei soli `data-image`;
  - i `src` diventano `data:` e niente parte verso un host esterno;
  - la CSP del frame non contiene più `https:`;
  - un'immagine che fallisce resta con l'`alt`;
  - il tetto delle 50;
  - il calendario senza bottone.
- `numberRemoteImages`: stessa numerazione sull'HTML della risposta e su
  quello della rotta.

## 11. Deploy e rollback

- **Ordine**: prima `server` (la rotta nuova e il `data-image` di
  `/original`), poi `caddy` (il renderer che li usa). L'app Mac si
  ricostruisce a mano.
- Nessuna migrazione e nessuna env. Se servisse spegnere il proxy, basta la
  costante del tetto di concorrenza a 0, ma non propongo un'env.
- **Rollback**: sicuro. Un renderer nuovo con un server vecchio non trova
  `data-image`, e le immagini restano spente come oggi. Un renderer vecchio
  con un server nuovo ignora l'attributo.

## Note d'implementazione (28 nov 2026)

- Approvato da 46 per il maintainer, [PI 1]–[PI 10] come proposti, con due
  precisazioni: il calendario va nel registro (fatto, area 6), e l'host si
  ricontrolla dopo la normalizzazione (IDN, IP in decimale, ottale,
  esadecimale, `[::ffff:…]`) e senza credenziali (`address.ts`, coi test).
- **[PI 10] cambiato**: la rotta NON è fuori dal catalogo MCP. L'elenco delle
  esclusioni (`DeclaredMcpExclusion`) è chiuso, e le immagini binarie dei
  Docs di prodotto ci stanno già come `download_file`
  (`productDocs.image`). Per la parità MCP, decisa dal maintainer il 26 nov,
  anche questa è `mail.image` con `tool: "download_file"`.
- Un difetto trovato scrivendo i test del frame: l'HTML del server porta le
  immagini già parcheggiate (`data-src`), quindi `neutralize` non le contava e
  nella build app la fascia «Show images» non compariva mai. Ora la fascia
  conta anche le posizioni numerate.

### Dopo la revisione di sicurezza (28 nov 2026)

- **I1**: con un nome host il trasporto vero non funzionava (da Node 20
  `autoSelectFamily` chiede il `lookup` con `{ all: true }`): il `lookup`
  risponde con l'elenco, sempre sull'indirizzo controllato. Il trasporto è
  `createNodeRequest`, provato contro un server TLS locale
  (`fetch.node.test.ts`: SNI e `Host` del nome, certificato verificato, un
  nome non coperto rifiutato).
- **I2**: il DNS è `dns.Resolver` (c-ares: un tentativo, 2 s, fuori dal
  threadpool di libuv) ed è in corsa col tetto degli 8 s; il semaforo ha una
  coda di al più 16 e un'attesa di al più 3 s (oltre: `busy`, 422); al più 4
  immagini in volo per persona (oltre: 429).
- **I3**: gli URL di un messaggio si memoizzano (solo gli URL, 5 minuti, al
  più 500 messaggi); oltre 1 MB di corpo le immagini non si offrono
  (`/original` non numera, la rotta risponde 404).
- **M1** la richiesta si chiude sempre (`abort` nel `finally`); **M2** un
  `https.Agent` esplicito senza keep-alive (niente proxy d'ambiente); **M3**
  IPv6 in allowlist (solo `2000::/3`, meno `2001::/23`, `2001:db8::/32`,
  `2002::/16`, `3fff::/20`) e `168.63.129.16`; **M5** SNI e `Host` senza il
  punto finale; **M6** `Cache-Control: no-store` (cambia [PI 9]); **M7**
  nell'invariante.
- **M4, accettato**: un oracolo di tempo, solo per il proprietario della
  casella. Un nome interno che risolve a un IP privato si rifiuta subito dopo
  il DNS, mentre un NXDOMAIN o un host esterno hanno tempi diversi: chi si
  manda un'email da solo può sapere se un nome DNS interno esiste (per
  esempio i nomi del compose). Non può scansionare porte né servizi, perché
  nessuna connessione parte verso un indirizzo vietato, e la risposta è
  sempre lo stesso 422.

## Le scelte da confermare

- **[PI 1]** Le immagini si chiedono per posizione nel messaggio, non con un
  token firmato per (messaggio, URL). Stessa garanzia (nessun URL dal
  client), niente chiave da gestire.
- **[PI 2]** Il PAT `desktop` vale come per `/original`.
- **[PI 3]** Solo `https` sulla 443: le immagini `http:` restano spente.
- **[PI 4]** Tetti: 5 MB, 3 s di connessione, 8 s in tutto, 3 redirect.
- **[PI 5]** Niente SVG, mai.
- **[PI 6]** Lo User-Agent generico, uguale per tutte le istanze.
- **[PI 7]** Il web vecchio resta com'è fino al ritiro.
- **[PI 8]** Nelle descrizioni del calendario «Show images» non c'è più
  (il proxy agli eventi, se serve, è un pezzo a parte).
- **[PI 9]** Nessuna cache sul server; `private, max-age=3600` nel browser.
- **[PI 10]** La rotta è fuori dal catalogo MCP.
