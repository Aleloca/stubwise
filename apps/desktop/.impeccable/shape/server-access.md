# Shape brief — Accesso SSH di un server

Superficie: parte **SSH access** del dettaglio di un server
(`#/p/<CODE>/servers/SRV-<n>?section=access`, vedi `servers.md`), con i
dialoghi di Rigenera e Revoca e il comando di rimozione; azione ⌘K «Link
SSH access» sul server corrente; la seconda riga dell'elenco dei server
quando l'accesso non è verificato. Piano 8b: Task 8 (dati: Task 4).
Spec area 8: «Gli accessi SSH», «Permessi», «Stati» (Accesso SSH),
«Quanto è vero nel prototipo», Review Focus 2–3. Mondo: «Catalogo
numerato», modalità **Operate**; il comando da incollare è l'unico testo
monospace della parte (Global Constraints: comandi e script). Scelte del
brief **[SA n]**, raccolte in fondo; quelle che cambiano ciò che si vede
in «Scelte da confermare».

## 1. Lavoro e pubblico

- **Chi**:
  - **Chi collega** (Roberta, admin con `servers.ssh.manage`): ha accesso
    root al server, deve incollare un comando che non ha scritto. Vuole
    **leggere cosa fa** prima di eseguirlo e sapere, dopo, se ha
    funzionato.
  - **Chi guarda** (Laura, Marco, Sara: membri del progetto): vuole sapere
    se Claude può guardare dentro il server e se qualcuno l'ha usato, e
    quando. Nessuna azione.
- **Stato d'animo**: cautela. Si sta dando a un agente la possibilità di
  entrare in un server di produzione, e per uno dei due utenti di fare
  **tutto**. La parte deve dirlo senza giri di parole e senza allarmismo,
  una volta, nel punto in cui si decide.

## 2. Esito e prova

- **Azioni primarie** (solo `servers.ssh.manage`): (1) collegare i due
  accessi in tre passi; (2) rigenerare le chiavi senza perdere l'accesso;
  (3) revocare e ripulire il server.
- **Successo**, a 1440×900:
  - prima di copiare, so che il comando crea **due utenti** e cosa può fare
    ciascuno: «stubwise-read — reads logs, processes, disk and memory. It
    can't change anything.» e «stubwise-fix — **can do anything on the
    server.**»;
  - dopo «Verify» leggo un esito **per accesso** in una frase («Read
    access works, and it can't write.» / «Fix access failed: the key was
    refused.»);
  - a riposo, due righe mi dicono stato e ultimo uso di ciascun accesso,
    con il link a cosa l'ha usato.
- **Verità del prodotto** (mai ammorbidite):
  - **le chiavi private non si vedono mai**: né qui, né nel comando, né
    altrove. Il comando contiene solo chiavi pubbliche, e la parte lo dice
    («The command contains only public keys. Private keys are encrypted
    and never shown.»);
  - **un accesso di lettura che scrive è un errore**, non un successo:
    spegne entrambi gli accessi finché una verifica non riesce;
  - **rigenerare non interrompe**: le chiavi in uso restano valide finché
    le nuove non passano la verifica;
  - **revocare non tocca il server**: Stubwise dimentica le chiavi, e
    rimuovere gli utenti è un comando che una persona esegue.

## 3. Direzione scelta

- **Tesi**: **una procedura numerata che si chiude in uno stato**. Finché
  i due accessi non sono verificati, la parte è una procedura in tre passi
  (1 Link · 2 Run the command · 3 Verify) con il passo corrente aperto e i
  passi fatti ridotti a una riga con ✓; a verifica riuscita la procedura si
  chiude e restano **due righe di stato**, una per accesso **[SA 1]**.
- **Momento focale**: il passo 2 — il comando, preceduto dalle due righe
  che dicono cosa crea, con la frase su `stubwise-fix` accanto al nome
  dell'utente.

```
SSH access                                                         ⋯
Two accesses let Claude look into SRV-1, and fix it from a task.

 ✓ 1  Link SSH access                       Keys created Oct 29, 10:12
 ●2  Run this command on SRV-1
      It creates two users:
      stubwise-read  Reads logs, processes, disk and memory. Can't change anything.
      stubwise-fix   ▲ Can do anything on the server (passwordless sudo).
                     Used only by a fix someone started and whose plan was approved.
      ┌──────────────────────────────────────────────────────────── [Copy] ┐
      │ #!/bin/sh                                                          │
      │ # Stubwise — SSH access for SRV-1. Only public keys below.         │
      │ set -eu                                                            │
      │ useradd --system --create-home --shell /bin/bash stubwise-read     │
      │ …                                                     Show all 38 │
      └────────────────────────────────────────────────────────────────────┘
      Run it as root. Read it first: it contains only public keys.
   3  Verify                                                   [Verify]
```

### Intestazione della parte

- `headline` «SSH access» · a destra «⋯» (solo `servers.ssh.manage`, solo
  quando c'è qualcosa da fare: «Show command again», «Regenerate keys…»,
  «Revoke access…»).
- Riga in prosa `ink-muted`: «Two accesses let Claude look into SRV-1, and
  fix it from a task.»

### Passo 1 — Link

- Testo: le due righe degli utenti (le stesse del passo 2, in forma breve)
  e «Stubwise creates two key pairs. Private keys are encrypted and never
  shown.» → **Link SSH access** (primario della parte).
- Fatto: riga ridotta «✓ 1 Link SSH access · Keys created Oct 29, 10:12».

### Passo 2 — Il comando

- **Chi crea cosa**, prima del comando, in una piccola tabella a due righe
  (nome utente in cifre tabellari 600, descrizione 13px):
  - `stubwise-read` — «Reads logs, processes, disk and memory. Can't
    change anything.» e sotto, 12px `ink-faint`, «Not in the docker group;
    `docker inspect` isn't allowed (it shows secrets).»
  - `stubwise-fix` — glifo ▲ `warning` + «**Can do anything on the
    server** (passwordless sudo).» e sotto, 12px `ink-muted`, «Used only
    by a fix that someone allowed started from a task, after its plan was
    approved.» **[SA 2]**.
- **Il comando**: blocco monospace 12px su fondo `ink/4`, filetto `rule`,
  raggio 6px, con i commenti dello script leggibili; alto fino a 12 righe,
  poi «Show all 38 lines» lo apre in posto. **Copy** in alto a destra del
  blocco (toast «Command copied»). Sotto: «Run it as root on SRV-1. Read it
  first: it contains only public keys.»
- Le impronte delle chiavi pubbliche sotto il blocco, 12px: «read
  SHA256:3f9a…c21e · fix SHA256:91be…07d4» (intere nel `title`).
- Prototipo: una riga 12px `ink-faint`: «Prototype: these keys are made up
  by the prototype.»
- Il comando si può rivedere finché l'accesso non è revocato («Show
  command again» nel «⋯»): contiene solo chiavi pubbliche.

### Passo 3 — Verify

- **Verify** (primario quando il passo 2 è aperto da prima; durante:
  «Verifying…» con l'anello, il bottone resta al suo posto).
- **Esiti**, uno per accesso, come righe con glifo + frase:
  - ok: ✓ `positive` «Read access works, and it can't write.» · ✓ «Fix
    access works.» → la procedura si chiude (transizione 200ms) e restano
    le righe di stato;
  - lettura fallita: ✕ `critical` «Read access failed: the server refused
    the key. Was the command run on SRV-1?»; l'altra riga dice il suo
    esito;
  - correzione fallita: come sopra per «Fix access»;
  - **lettura che scrive**: riquadro con filetto `critical` a sinistra (il
    solo della parte): «Read access can write. That's an error: both
    accesses are off until a verification passes.» e sotto «Check that
    stubwise-read isn't in the sudo or docker group, then verify again.»
    **[SA 3]**;
  - irraggiungibile: «Couldn't reach SRV-1 over SSH (port 22). Neither
    access could be checked.»
  - Dopo un esito negativo la procedura resta aperta sul passo 3 con
    **Verify again** e «Show command again».
- Errore del livello dati (non un esito): toast «Couldn't verify. Try
  again.» · **Retry**.

### A riposo: le due righe di stato

- Una riga per accesso (44px): nome dell'accesso «Read access» / «Fix
  access» · utente `stubwise-read` 12px `ink-muted` · stato in parola con
  glifo («Verified Oct 29», «Check failed», «Off: read access can
  write», «Waiting for the command») · **ultimo uso** a destra: «Used 2 d
  ago by the analysis of SRV-1 · Open session» / «Used 1 h ago by
  ACQ-57» (link) / «Used 1 h ago by a task you can't see» / «Not used
  yet».
- Sotto la riga del fix, sempre, 12px `ink-muted` con ▲: «Can do anything
  on the server.» (la frase non sparisce a procedura chiusa).
- Azioni nel «⋯» dell'intestazione (non in riga): Show command again ·
  Verify again · Regenerate keys… · Revoke access…

### Rigenera

- Dialogo 440px «Regenerate SRV-1's keys?»: «You get new keys and a new
  command. The current keys keep working until the new ones pass
  verification.» · **Regenerate**.
- Dopo: stato **Regenerating**. Le righe di stato restano (in uso, con il
  loro ultimo uso) e sopra si riapre la procedura per le **nuove** chiavi,
  dal passo 2, con il titolo «New keys — not in use yet». Verifica
  riuscita: le nuove passano in uso, le vecchie vengono dimenticate
  (riga di esito: «The new keys are in use. Stubwise forgot the old
  ones.»); fallita: «The new keys didn't pass. The current ones are still
  in use.»

### Revoca

- Dialogo 440px «Revoke SSH access to SRV-1?» con le conseguenze, una per
  riga: «Claude can't look into SRV-1's problems any more.» · «A fix
  running on SRV-1 stops.» · «A fix plan waiting for approval can't be
  approved.» · «Stubwise forgets the keys. The users stay on the server
  until you remove them.» · **Revoke access** (`critical`) **[SA 4]**.
- Dopo: la parte mostra **il comando di rimozione** (blocco monospace con
  Copy, `userdel` dei due utenti e pulizia di `sudoers`) sotto «Access
  revoked Oct 29, 11:40. To remove the two users from SRV-1, run:», con
  **Done** che lo chiude. Chiuso, lo stato è «Revoked Oct 29» con **Link
  again** (riparte dal passo 1). Il comando di rimozione resta
  raggiungibile dal «⋯» («Show removal command») finché non si ricollega.

### Chi non ha `servers.ssh.manage`

- Vede le stesse **righe di stato** (anche in attesa, fallita, revocata) e
  l'ultimo uso, nessun «⋯», nessun comando, nessuna impronta. Non vede la
  procedura: al suo posto, nello stato non collegato, «Not linked. Claude
  can't look into this server's problems.» e 12px «An admin who manages
  SSH access can link it.» **[SA 5]**.

### Prototype only

- Riquadro tratteggiato dell'8a sotto la parte, solo `servers.ssh.manage`
  (è l'unica persona che può verificare): «Next verification:» · scelta
  fra «Works» · «Read access fails» · «Fix access fails» · «Read access
  can write» · «Server unreachable»; frase «This decides what the next
  Verify answers. Nothing connects to a server.»

## 4. Ambito e confini

- **Dentro**: i tre passi, i sette stati, gli esiti per accesso, Rigenera,
  Revoca con comando di rimozione, ultimo uso con link, vista senza
  permessi, ⌘K «Link SSH access» (solo `servers.ssh.manage`, sul server
  aperto; porta a `?section=access`), riquadro «Prototype only».
- **Fuori**: scegliere quali comandi ammettere a `stubwise-read` (elenco
  fisso del piano), più di due accessi, chiavi caricate dall'utente,
  porta o utente SSH diversi, l'indirizzo dell'istanza (`from=`, letto
  dalla configurazione).
- **Anti-obiettivi**: una chiave privata nel DOM (il test lo verifica sul
  testo della pagina); «lettura che scrive» mostrato con un glifo di
  successo; la frase su `stubwise-fix` nascosta in un tooltip o solo in
  fondo allo script; un `curl … | sh`; un bottone che esegue qualcosa sul
  server.

## 5. Stati e intervalli

| Stato (`AccessState`) | Chi gestisce vede | Chi guarda vede |
|---|---|---|
| `not_linked` | passo 1 aperto | «Not linked…» |
| `awaiting_command` | passo 2 aperto, passo 3 pronto | «Waiting for the command» |
| `verified` | due righe di stato | due righe di stato |
| `verify_failed` | passo 3 con l'esito per accesso | «Check failed» sulla riga giusta, motivo in parola |
| `read_writes` | riquadro d'errore + Verify again | «Off: read access can write» su entrambe |
| `regenerating` | righe in uso + procedura delle nuove | righe in uso, «New keys being set up» |
| `revoked` | comando di rimozione, poi «Link again» | «Revoked Oct 29» |

- **Script**: ~30–45 righe; impronte troncate a 8+4 caratteri.
- **Ultimo uso**: mai, ore, giorni («Oct 12» oltre la settimana); un
  oggetto non visibile non si nomina.
- **Caricamento**: la parte ha il suo scheletro (due righe); **errore**
  della parte: «Couldn't load SSH access» + **Retry**, il resto del
  dettaglio intatto.
- **Cambio di persona** con la procedura aperta: passando a chi non
  gestisce, la procedura sparisce e restano le righe di stato.

## 6. Interazione e layout

- La parte occupa la colonna del dettaglio (fino a 1120px), il blocco del
  comando fino a 760px (righe lunghe scorrono in orizzontale **dentro** il
  blocco, mai la pagina).
- Fuoco: dopo «Link SSH access» il fuoco va al titolo del passo 2; dopo
  «Verify» all'esito (annunciato in `aria-live="polite"`); dopo Revoca al
  titolo del comando di rimozione.
- **Movimento**: apertura e chiusura dei passi 200ms in altezza; nulla
  sotto reduced-motion.
- 1024×680: invariata; la tabella dei due utenti va a capo sotto il nome.

## 7. Vincoli

- Solo via `data/queries.ts` (`linkSshAccess`, `getInstallCommand`,
  `verifySshAccess`, `regenerateSshAccess`, `revokeSshAccess`, vista
  `ServerDetail.access`); la UI non deduce lo stato, legge `AccessState`.
- Testi en/it con parità; esiti per `VerifyOutcome`.
- Riuso: blocco di codice con Copy (lo stesso stile del log delle
  Releases, senza la ricerca), riquadro «Prototype only», dialoghi e toast
  esistenti.

## Scelte del brief

1. **[SA 1]** Procedura numerata che si chiude in due righe di stato.
2. **[SA 2]** La frase «Can do anything on the server» accanto a
   `stubwise-fix`, con glifo ▲ `warning`, nel passo 2 e a riposo.
3. **[SA 3]** «Lettura che scrive» come riquadro d'errore con filetto
   `critical`, l'unico della parte.
4. **[SA 4]** Revoca con dialogo delle conseguenze, poi il comando di
   rimozione in posto fino a «Done».
5. **[SA 5]** Chi non gestisce non vede comando né impronte.

## Scelte da confermare

1. **Tre passi numerati** che, a verifica riuscita, si chiudono in due
   righe di stato (una per accesso, con ultimo uso) **[SA 1]**.
2. **«Can do anything on the server»** scritto accanto a `stubwise-fix`
   con un glifo d'avviso ambra, e lasciato visibile anche a procedura
   chiusa **[SA 2]**.
3. **Revoca**: dialogo con le quattro conseguenze, poi il comando di
   rimozione mostrato nella parte finché non si preme «Done» **[SA 4]**.
