---
"@stubwise/shared": minor
---

`agentSessionQuestionSchema` guadagna due campi additivi: `answer` (la risposta data, opzione o testo libero, `.nullable().default(null)`) e `dismissed` (domanda del backlog chiusa con «non ora», `.default(false)`), così la sessione dell'agente mostra la scelta fatta.
