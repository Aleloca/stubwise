---
"@stubwise/mcp": minor
"@stubwise/claude-plugin": minor
---

La parità con la nuova app è completa: ogni azione dell'app si fa anche da Claude Code, tranne le password della cassaforte e le azioni che chiedono di riconfermare l'identità.

- Le task: `list_tasks` e `list_task_fields` per leggerle, `update_task` per spostarle di settimana o di giorno, cambiarne stato, assegnatario, priorità, reparto e dimensione (assegnarle a Claude avvia il lavoro, e Claude lo dice), `get_by_code` per aprire una cosa dal suo codice (ACQ-12).
- I file: `upload_file` allega un file del tuo computer, `download_file` ne scarica uno in una cartella del progetto. Nessuno dei due tocca cartelle nascoste, file di sistema o i file d'istruzioni di Claude.
- `find_actions` capisce meglio le richieste in italiano («sincronizza», «manda», «sposta», «posta»…), e a parità di punteggio mette prima la voce che corrisponde alla parola più rara della richiesta.
