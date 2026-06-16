# Stubwise — Backlog funzionalità future

Idee di funzionalità valutate dopo la prima fase di sviluppo + deploy in produzione (giugno 2026). Ordinate per area, con una nota di valore/priorità. Da referenziare quando si pianifica il prossimo lavoro.

## 1. Rendere l'AI più affidabile e "fidabile" (il differenziatore principale)

- ~~**Notifiche** (email / Slack / webhook). Oggi l'AI apre una PR e nessuno lo sa finché non guarda la UI. Eventi tipici: ticket assegnato, PR aperta sul ticket, job AI fallito, job in attesa.~~ → ✅ **FATTA** (webhook Slack/Discord/generic, con docs).
- ~~**Human-in-the-loop sul piano**: per tipi/effort rischiosi, far produrre a Opus il piano e fermarsi in attesa di approvazione umana prima dell'esecuzione (estensione dello stato "held").~~ → ✅ **FATTA** (soglia `plan_approval_min_effort` per tipo → stato `awaiting_plan_approval` + Approva/Rifiuta).
- ~~**Loop di feedback sulla PR**: gestire la **PR rifiutata/chiusa senza merge** (riapri ticket) e il **"ri-esegui con istruzioni"** (un umano commenta una guida e rilancia il fix incorporandola).~~ → ✅ **FATTA** (webhook `closed_unmerged` → ticket riaperto + stato job `pr_closed`; "Rilancia con istruzioni" via commenti del team nel prompt).
- **Self-repair**: se il fix produce un diff ma i test falliscono, loop limitato di auto-correzione invece del fallimento conservativo attuale.
- **Budget/guardrail di costo**: tetti di spesa (per ticket/periodo) con stop/alert, sfruttando il tracking costi già presente.

## 2. Essere un vero tracker da team

- **Ricerca full-text** su titolo + body + commenti (oggi solo filtro ILIKE sul titolo).
- **Cronologia/audit** delle azioni umane (chi ha cambiato cosa), oltre alla timeline AI.
- **Relazioni tra ticket** (blocca / relativo / sotto-task).
- **Allegati/screenshot** (lo screenshot del feedback SDK non è ancora salvato/mostrato).
- **Editor markdown ricco** per body e commenti.
- **Milestone / viste salvate** (gli sprint erano stati esclusi dal v1; valutare milestone leggere).

## 3. Visione "confluire TUTTI i ticket di TUTTI i progetti"

- **SDK per altri linguaggi** (PHP, Python). Oggi solo JS/TS: senza, i progetti non-JS non possono confluire nulla. Probabilmente l'investimento più allineato all'idea iniziale.
- **Ingestion in entrata da fonti esterne**: email→ticket, GitHub Issues, Slack→ticket.
- **Altri provider git**: GitLab / Gitea (l'interfaccia `GitProvider` è già pronta) — utile per l'adozione open-source.

## 4. Operativo / analytics

- **Dashboard metriche**: tasso di successo dei fix, costo medio, % auto-fix vs "in attesa", tempo medio — per tarare le soglie di automazione.
- **Vista job falliti** con motivo + re-run di gruppo.
- **Scaling multi-worker** (oggi worker singolo con lock in-process): coda distribuita se serve throughput.
- **Quota/rate AI per progetto**: evitare che un progetto rumoroso saturi capacità/budget.

---

**Le tre da fare per prime (raccomandazione iniziale):**
1. ~~Notifiche~~ → ✅ **FATTA.**
2. ~~Loop di feedback AI (rifiuto PR + ri-esegui-con-istruzioni + approvazione piano).~~ → ✅ **FATTA.**
3. SDK PHP/Python (se ci sono progetti non-JS) oppure dashboard analytics. → **prossima candidata.**

**Extra completate fuori dalla lista iniziale:**
- ~~Internazionalizzazione (i18n): UI per-utente (react-i18next, en default + it), contenuti/LLM/notifiche per-istanza, errori API in inglese con code.~~ → ✅ **FATTA** (giugno 2026; design+piano in docs/plans/2026-06-15-stubwise-i18n-*.md, migrazione 0013, pacchetto @stubwise/i18n).
- ~~Docs (Astro Starlight) in inglese.~~ → ✅ **FATTA** (tradotti i 15 file, defaultLocale=en). NB: scelto solo-inglese (l'italiano non è più nelle docs); se in futuro serve, si può aggiungere it come locale secondario con lo switcher Starlight.
