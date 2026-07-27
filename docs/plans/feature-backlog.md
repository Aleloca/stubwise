# Stubwise — Backlog funzionalità future

Idee di funzionalità valutate dopo la prima fase di sviluppo + deploy in produzione (giugno 2026). Ordinate per area, con una nota di valore/priorità. Da referenziare quando si pianifica il prossimo lavoro.

## 1. Rendere l'AI più affidabile e "fidabile" (il differenziatore principale)

- ~~**Notifiche** (email / Slack / webhook). Oggi l'AI apre una PR e nessuno lo sa finché non guarda la UI. Eventi tipici: ticket assegnato, PR aperta sul ticket, job AI fallito, job in attesa.~~ → ✅ **FATTA** (webhook Slack/Discord/generic, con docs).
- ~~**Human-in-the-loop sul piano**: per tipi/effort rischiosi, far produrre a Opus il piano e fermarsi in attesa di approvazione umana prima dell'esecuzione (estensione dello stato "held").~~ → ✅ **FATTA** (soglia `plan_approval_min_effort` per tipo → stato `awaiting_plan_approval` + Approva/Rifiuta).
- ~~**Loop di feedback sulla PR**: gestire la **PR rifiutata/chiusa senza merge** (riapri ticket) e il **"ri-esegui con istruzioni"** (un umano commenta una guida e rilancia il fix incorporandola).~~ → ✅ **FATTA** (webhook `closed_unmerged` → ticket riaperto + stato job `pr_closed`; "Rilancia con istruzioni" via commenti del team nel prompt).
- ~~**Self-repair**: se il fix produce un diff ma i test falliscono, loop limitato di auto-correzione invece del fallimento conservativo attuale.~~ → ✅ **FATTA** (giugno 2026; il worker ri-esegue i test e cicla fino a SELF_REPAIR_MAX_ATTEMPTS; design+piano in docs/plans/2026-06-16-stubwise-ai-reliability-*.md).
- ~~**Budget/guardrail di costo**: tetti di spesa (per ticket/periodo) con stop/alert, sfruttando il tracking costi già presente.~~ → ✅ **FATTA** (tetto per-ticket per tipo + mensile d'istanza; held + notifica job.budget_held al superamento, manualTrigger scavalca; migrazione 0014).

## 2. Essere un vero tracker da team

- ~~**Cronologia/audit** delle azioni umane (chi ha cambiato cosa), oltre alla timeline AI.~~ → ✅ **FATTA** (activity feed unico: commenti + eventi job AI + `ticket_events`; migrazione 0015; design in docs/plans/2026-06-16-stubwise-team-tracker-design.md).
- ~~**Relazioni tra ticket** (blocca / relativo / sotto-task).~~ → ✅ **FATTA** (`ticket_links` blocks/relates_to/parent + inverse derivate + voci nel feed; migrazione 0016).
- ~~**Ricerca full-text** su titolo + body + commenti (oggi solo filtro ILIKE sul titolo).~~ → ✅ **FATTA** (tsvector + GIN su titolo+body, query commenti; `websearch_to_tsquery('english')`; migrazione 0017; ranking ts_rank rimandato a follow-up).
- ~~**Editor markdown ricco** per body e commenti.~~ → ✅ **FATTA** (componente `MarkdownEditor`: toolbar bold/italic/code/link/list + anteprima live; solo frontend, nessuna migrazione).
- ~~**Allegati/screenshot** (lo screenshot del feedback SDK non è ancora salvato/mostrato).~~ → ✅ **FATTA** (storage S3-compatible configurabile da Settings con secret cifrata; tabella `attachments`; upload via server con allowlist MIME + 10 MB; download presigned; screenshot automatico del feedback SDK via html2canvas salvato come allegato; migrazione 0018; piano in docs/plans/2026-06-16-stubwise-attachments-implementation.md).
- ~~**Milestone / viste salvate** (gli sprint erano stati esclusi dal v1; valutare milestone leggere).~~ → ✅ **FATTA** (milestone per-progetto con scadenza opz. + stato open/closed + avanzamento ticket; assegnazione ticket con evento `milestone_changed` nel feed; filtro per milestone; viste salvate private/condivisibili con rinomina/toggle-share; migrazione 0019; piano in docs/plans/2026-06-16-stubwise-milestones-saved-views-implementation.md).

**→ Sezione 2 "Vero tracker da team" COMPLETATA (6/6).**

## 3. Visione "confluire TUTTI i ticket di TUTTI i progetti"

- **SDK per altri linguaggi** (PHP, Python). Oggi solo JS/TS: senza, i progetti non-JS non possono confluire nulla. Probabilmente l'investimento più allineato all'idea iniziale.
- **Ingestion in entrata da fonti esterne**: ~~Slack→ticket~~ ✅ + ~~webhook generico~~ ✅ **FATTI** (giugno 2026: `POST /api/inbound/:slug/ticket` con ingestion key; Slack slash command `/stubwise` + message action con modal, verifica firma HMAC, credenziali cifrate; attribuzione via email; migrazione 0020; design+piano in docs/plans/2026-06-18-stubwise-external-ingestion-*.md). **Rimangono:** email→ticket e GitHub Issues→ticket (rimandati per scelta).
- **Altri provider git**: GitLab / Gitea (l'interfaccia `GitProvider` è già pronta) — utile per l'adozione open-source.

## 4. Operativo / analytics

- ~~**Monitoraggio server/servizi self-hosted**: agente Docker (`packages/agent`) sugli host proprietari che spinge metriche host (CPU/RAM/disco/rete), auto-discovery container Docker + app PM2 (scan `/proc`), e check espliciti http/tcp/process/postgres/mysql; superficie push `/monitor/ingest|config` con chiave per-server hashata; retention 48h fini + 90gg rollup 5min; alert via notifiche (soglie sostenute + offline + check down, con isteresi e recovery); sezione Monitor nella SPA (lista + dettaglio con grafici uPlot) e tab Server per progetto.~~ → ✅ **FATTA** (luglio 2026; design+piano in docs/plans/2026-07-13-server-monitoring-*.md; migrazioni 0047/0048; al deploy: ribuildare server+worker+caddy e pubblicare l'immagine `stubwise/agent`). **Follow-up (hardening, non bloccanti):** (1) `sanitizeError` nell'agente redige solo il match esatto del DSN — irrobustire per redigere anche la sola password/varianti percent-encoded; (2) le view TS del client web (`ServerView`/`ServerCheck`/punti metrica) sono scritte a mano, non `z.infer` dagli schemi server → rischio di drift futuro; (3) `swapUsedBytes` non è nel rollup 5min → oltre 48h lo swap non è graficabile; (4) downsampling server-side per i range 30g/90g (oggi il rollup 5min sfora `METRICS_POINT_LIMIT`=6000, la response lo segnala con `truncated`); (5) alert → ticket automatico (in v1 solo notifica).
- **Dashboard metriche**: tasso di successo dei fix, costo medio, % auto-fix vs "in attesa", tempo medio — per tarare le soglie di automazione.
- **Vista job falliti** con motivo + re-run di gruppo.
- **Scaling multi-worker** (oggi worker singolo con lock in-process): coda distribuita se serve throughput.
- **Quota/rate AI per progetto**: evitare che un progetto rumoroso saturi capacità/budget.
- **Integrazione graphify (fase 1)**: knowledge graph del codice per repository (tree-sitter, zero LLM) generato dal worker e tenuto fresco sul push; PR di setup sul repo target (graph committato + skill + config MCP: i dev pullano e hanno tutto); tab "Grafo" nella sezione Docs (GRAPH_REPORT.md + graph.html interattivo); container `graphify serve` HTTP nel compose per i futuri consumatori (chat backlog/docs). Design validato in docs/plans/2026-07-27-graphify-integration-design.md (con prova empirica sul monorepo: 41s, 5.701 nodi, 0 token). Fasi successive fuori scope: retrieval ibrido nella chat RAG, impatto grafo nella PR review, orient Docs seedato dal grafo.

---

**Le tre da fare per prime (raccomandazione iniziale):**
1. ~~Notifiche~~ → ✅ **FATTA.**
2. ~~Loop di feedback AI (rifiuto PR + ri-esegui-con-istruzioni + approvazione piano).~~ → ✅ **FATTA.**
3. SDK PHP/Python (se ci sono progetti non-JS) oppure dashboard analytics. → **prossima candidata.**

**Extra completate fuori dalla lista iniziale:**
- ~~Internazionalizzazione (i18n): UI per-utente (react-i18next, en default + it), contenuti/LLM/notifiche per-istanza, errori API in inglese con code.~~ → ✅ **FATTA** (giugno 2026; design+piano in docs/plans/2026-06-15-stubwise-i18n-*.md, migrazione 0013, pacchetto @stubwise/i18n).
- ~~Docs (Astro Starlight) in inglese.~~ → ✅ **FATTA** (tradotti i 15 file, defaultLocale=en). NB: scelto solo-inglese (l'italiano non è più nelle docs); se in futuro serve, si può aggiungere it come locale secondario con lo switcher Starlight.
