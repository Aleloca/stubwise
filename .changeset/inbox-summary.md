---
"@stubwise/shared": minor
---

Riassunti "in breve" negli schemi condivisi: `inboxItemSchema.summary`, `ticketDetailSchema.planSummary` e `aiJobSchema.planSummary`. Sono due o tre frasi in linguaggio non tecnico su cosa un piano cambia o su cosa fa una PR, generate dal worker e riempite dal server quando esistono. Tutti e tre i campi sono **opzionali**: le risposte restano valide per i client che non li conoscono (l'app mobile installata li scarta), e un riassunto assente non è mai `null` nella risposta d'inbox ma semplicemente non c'è.
