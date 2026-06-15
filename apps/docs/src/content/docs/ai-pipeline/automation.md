---
title: Automazione AI
description: "Triage sempre attivo (tipo + effort + decisione), regole per tipo di ticket, gate auto/in attesa e avvio manuale del fix."
---

L'automazione decide **se e quando** la pipeline AI prova a risolvere un ticket
da sola. Una prima fase di **triage gira sempre**; il **fix** parte in automatico
solo se le regole che imposti in **Impostazioni → Automazione AI** lo consentono,
altrimenti il job resta **in attesa** e puoi avviarlo a mano.

## Il triage gira sempre

Per ogni ticket che entra in coda, la pipeline esegue un **triage** con il
modello economico **haiku** (vedi [Come funziona](/docs/ai-pipeline/how-it-works/)).
Il triage fa tre cose:

1. **Valida e ri-classifica il tipo.** Non si fida del tipo in arrivo: decide lui
   se il ticket è `bug`, `feature`, `task` o `feedback`. È il tipo
   ri-classificato a contare per le regole di automazione qui sotto.
2. **Stima l'effort**, su una scala da **1 a 5**, salvata sul ticket:

   | Effort | Etichetta    |
   | ------ | ------------ |
   | 1      | Banale       |
   | 2      | Piccolo      |
   | 3      | Medio        |
   | 4      | Grande       |
   | 5      | Molto grande |

3. **Decide** una di tre azioni: **`fix`** (azionabile, vale la pena provare),
   **`skip`** (vago o da giudizio umano) o **`duplicate`** (stessa causa radice
   di un ticket recente).

Su `skip` e `duplicate` il job si chiude lì, con un commento `ai` che spiega il
motivo. Solo su `fix` entra in gioco il gate.

## Regole per tipo (Impostazioni → Automazione AI)

In **Impostazioni → Automazione AI** (solo admin) configuri, per ciascuno dei
quattro tipi di ticket, tre parametri:

- **Auto-fix** (on/off): se la pipeline può avviare il fix da sola per quel tipo.
- **Soglia effort** (`maxEffort`, 1–5): l'effort massimo per cui il fix parte in
  automatico.
- **Approvazione piano da effort ≥** (`Mai`, oppure 1–5): la soglia oltre la
  quale il fix si ferma a far approvare il piano da un umano prima di scrivere
  codice. Vedi [Approvazione del piano](#approvazione-del-piano) qui sotto.

I valori di default seminati sono:

| Tipo       | Auto-fix | Soglia effort |
| ---------- | -------- | ------------- |
| `bug`      | on       | ≤ 3 (Medio)   |
| `task`     | on       | ≤ 2 (Piccolo) |
| `feature`  | off      | —             |
| `feedback` | off      | —             |

L'idea: lascia che l'AI gestisca da sola i bug e i task piccoli, e tieni le
feature e i feedback alla revisione umana.

## Il gate: parte da solo o resta in attesa

Quando il triage decide **`fix`**, il fix parte **in automatico solo se**:

- il tipo (ri-classificato) ha **auto-fix ON**, **e**
- l'effort stimato è **≤ la soglia** di quel tipo.

Se entrambe le condizioni valgono, il job avanza a `fixing` e prosegue da solo.

Altrimenti il job resta **in attesa (held)**: il ticket va in stato `triaged`,
con un commento `ai` che spiega perché non è partito (auto-fix off, oppure effort
sopra soglia). Niente è perso: il triage è già stato fatto e il ticket porta il
tipo e l'effort stimati. Un job in attesa fa anche scattare l'evento
[`job.held`](/docs/notifications/) se hai configurato le notifiche.

### Un esempio

Con il default per i bug (auto-fix on, soglia 3):

- **un bug a effort 3** rientra nella soglia → il fix **parte da solo**;
- **un bug a effort 4** supera la soglia → il job **resta in attesa**, in stato
  `triaged`, in attesa di una decisione umana.

## Avvio manuale: "Avvia fix AI"

Sul dettaglio di un ticket rimasto **in attesa** compare il pulsante **"Avvia fix
AI"**: lo lanci a mano e il fix parte **bypassando il gate** (ignora auto-fix e
soglia). È il modo per dare il via libera caso per caso, senza allentare le
regole generali — utile per una feature che hai valutato tu, o per un bug
grande che vuoi comunque far tentare all'AI.

## Approvazione del piano

Per ogni tipo di ticket puoi pretendere che, **oltre una certa difficoltà**, un
umano approvi il piano dell'AI prima che questa tocchi il codice. Lo imposti con
la soglia **"Approvazione piano da effort ≥"**: `Mai` (default: nessun gate),
oppure un valore da **1 a 5**.

Se per il tipo del ticket la soglia è impostata e **l'effort stimato la
raggiunge**, il fix esegue **solo la fase di pianificazione** (Opus, sola
lettura) e poi **si ferma**:

- il **piano** viene salvato e mostrato come commento `ai` sul ticket;
- il job va in stato **`awaiting_plan_approval`**;
- il ticket passa a **`in_progress`**;
- scatta l'evento [`job.plan_review`](/docs/notifications/) (se configurato).

Sul dettaglio del ticket compaiono i pulsanti **Approva** / **Rifiuta**:

- **Approva** → il job riprende in **modalità esecuzione**, usando
  **esattamente il piano approvato** (Sonnet esegue, niente ri-pianificazione),
  poi commit, push e PR come di consueto.
- **Rifiuta** → il job **torna a pianificare** (il piano salvato viene scartato)
  incorporando i tuoi commenti come guida, e **si ferma di nuovo** in attesa di
  approvazione. Per indirizzare la nuova pianificazione, **scrivi un commento**
  con cosa correggere **prima** di premere Rifiuta.

:::note[Ortogonale all'avvio manuale]
Il gate di approvazione è **indipendente** da come è partito il fix: un fix
rischioso richiede l'approvazione del piano **anche se l'hai avviato a mano** con
"Avvia fix AI". Le due soglie hanno scopi diversi: `maxEffort` decide se il fix
parte da solo, "Approvazione piano da effort ≥" decide se il fix si ferma a far
rivedere il piano.
:::

## Come si lega al fix in due fasi e ai costi

Una volta che il fix parte — in automatico o a mano — segue la pipeline normale.
Per default il fix è **in due fasi** per contenere i costi: **Opus pianifica in
sola lettura** e **Sonnet esegue** (scrive il codice, i test e il report). Il
dettaglio della procedura è in [Come funziona](/docs/ai-pipeline/how-it-works/);
le variabili `FIX_*` che regolano modelli, timeout e il toggle delle due fasi
sono nella [Configurazione](/docs/ai-pipeline/configuration/).

I **token e il costo** sono tracciati **per ticket** e **per modello** (righe
`agent_runs` distinte per triage, pianificazione ed esecuzione): sul dettaglio
del ticket il pannello **"Consumi AI"** mostra quanto è costato ciascuno stadio.
Così l'effort stimato non è solo un filtro per il gate, ma anche una lente per
leggere a posteriori la spesa.
