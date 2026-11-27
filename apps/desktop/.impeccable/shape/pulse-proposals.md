# Shape brief — Le proposte del polso nella nuova app

> Stato: **bozza con domande**, 27 nov 2026 (94), per il ritiro del web
> vecchio (inventario `docs/plans/2026-11-27-ritiro-web-inventario.md`, 1.4).
> Il prototipo non pubblica proposte del polso: il pulse è del worker. Il
> commento di `data/claude/suggestions.ts` lo dice, e nessuna shape le
> descrive. Questa shape colma il vuoto; il codice viene dopo le risposte.

**Superficie**:
- la card `project.pulse` nel pannello delle notifiche (`NotificationItem`);
- la sua riga nel blocco **Decide** della Home (`DecideBlock`).

**Rotta**: `POST /api/inbox/:id/actions/:action`, la stessa del web vecchio
(`inbox-item.tsx`), con l'indice dell'opzione. Il server converte la voce di
backlog in task e lancia il run con l'approvazione del piano.

**Mondo**: «Catalogo numerato», modalità **Operate**. Scelte **[PP n]**.

## 1. Lavoro e pubblico

- **Chi:** chi riceve la card, cioè chi può avviare lavoro nel progetto.
  Laura vede «ACQ is idle for 9 days. Pick what to start.» con fino a tre
  voci di backlog. Ne sceglie una e preme Start, perché il progetto riparta
  senza aprire il backlog.
- **Stato d'animo:** «una cosa sola, adesso». La card propone, la persona
  decide. Niente parte da solo.

## 2. Esito e prova

- **Successo:**
  - nella Home, sotto Decide, c'è la riga «ACQ · idle for 9 days»; aprendola
    si leggono le tre voci, ognuna col titolo, l'urgenza e l'effort;
  - scelta una voce, **Start** dice prima che cosa succede: «Creates a task
    from this item and starts Claude on it. Claude writes a plan first; you
    approve it before any code changes.»;
  - dopo, la riga dice «Started ACQ-42» con il link alla task, e sparisce dal
    blocco Decide;
  - la stessa card si decide dal pannello delle notifiche, con lo stesso
    esito.
- **Verità del prodotto:**
  - **niente parte senza Start:** la card propone soltanto;
  - **il run passa dal piano:** la frase lo dice prima di Start, perché è la
    regola del server (approvazione del piano);
  - **una proposta superata si dice:** `proposal_stale`, cioè la voce non è
    più aperta, oppure il progetto ha già ripreso. In quel caso c'è la frase
    in parole, non un errore;
  - **chi non può avviare il lavoro** (`runs.start`) vede la card in sola
    lettura, con «Someone who can start runs in ACQ can start it. Who?».

## 3. Direzione

- **Nel pannello delle notifiche** (la card): titolo «ACQ is idle for 9
  days»; sotto, le voci come scelte radio. Ogni voce ha:
  - il titolo;
  - una riga 12px `ink-muted` con l'urgenza in parola e l'effort («High ·
    about 2 days»);
  - la raccomandata segnata «Suggested».

  Poi **Start** e **Not now** (archivia la card). Start, una volta scelta la
  voce, porta la frase di §2 sopra il bottone **[PP 1]**.
- **Nella Home, blocco Decide** **[PP 2]**: una riga come le altre del
  blocco, «ACQ · idle for 9 days · 3 items». Il clic la espande in posto con
  le stesse scelte e Start (come `MailDecisionItem`). Dopo Start, il toast
  «Started ACQ-42» con «Open».
- **Dopo:** la card dice «Started ACQ-42», con il link alla task che si apre
  nell'app, e va fra le gestite. In Decide la riga sparisce.

## 4. Stati

| Stato | Card | Riga di Decide |
|---|---|---|
| aperta | voci + Start / Not now | riga espandibile |
| in invio | Start `aria-busy` | idem |
| avviata | «Started ACQ-42» + link | sparisce |
| superata (`proposal_stale`) | «This proposal is out of date: nothing was started.» | sparisce alla rilettura |
| errore | «Couldn't start. Try again.» · Retry | idem |
| budget finito | Start spento con la frase del budget (come gli altri avvii) | idem |
| senza `runs.start` | in lettura + «Who?» | non compare |

## 5. Vincoli

- I dati vengono da `item.pulse` (progetto, giorni, `proposals[i]` allineato
  a `question.options[i]`) e da `question` (opzioni e raccomandata). L'indice
  che si manda è quello di `options`, come nel web.
- Nel prototipo serve un seme: una card `project.pulse` su un progetto fermo
  (gli inattivi del 10b) e la scrittura finta che crea la task e il run col
  piano. È l'unico posto dove il prototipo la pubblica.
- Testi en/it.

## Domande per il maintainer

Ognuna ha la mia raccomandazione per prima.

- **PP-Q1. Dove si decide?**
  - *Raccomandato:* nel pannello delle notifiche E nella Home (Decide),
    perché è una decisione che aspetta te, come le altre del blocco.
  - *Alternative:* solo nel pannello; oppure solo nella Home.
- **PP-Q2. «Not now» archivia soltanto, o dice al polso di non riproporre?**
  - *Raccomandato:* archivia soltanto, come oggi nel web. Il polso torna a
    proporre al giro successivo, se il progetto è ancora fermo.
- **PP-Q3. Si può scrivere un'istruzione libera prima di Start** (la
  `allowFreeText` della domanda)?
  - *Raccomandato:* no nel primo giro, solo la scelta fra le voci, com'è oggi
    nel web per il pulse.
- **PP-Q4. Chi non può avviare il lavoro la vede?**
  - *Raccomandato:* nel pannello sì, in lettura, con «Who?»; in Decide no,
    perché non è una decisione sua.
