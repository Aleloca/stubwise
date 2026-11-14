---
"@stubwise/mcp": minor
"@stubwise/claude-plugin": minor
---

Area 8, F3 — Support dal server MCP (modalità collaboratore). `create_backlog_item` accetta la conversazione con l'utente (`conversation`, facoltativa): viene allegata alla richiesta e il team la legge in Support. Il team risponde SOLO ai collaboratori interni di questo canale (al cliente del widget non scrive mai): le risposte arrivano con `my_requests`, sotto la richiesta. Nessuna bozza automatica, nessun avviso «ha risposto», nessun «Segui». Le istruzioni del server dicono di allegare la conversazione e dove trovare le risposte. Un server più vecchio ignora il campo.
