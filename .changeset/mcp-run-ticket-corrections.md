---
"@stubwise/mcp": patch
---

La descrizione di `run_ticket` dice che NON serve a correggere una PR già
aperta da Stubwise (ripartirebbe dal branch di default senza aggiornarla): una
PR aperta si corregge dal bottone «Applica le correzioni» sul ticket, web o
app, o con «Request changes» sulla PR, e la review AI ne avvia da sola un
numero limitato. Nessun tool MCP lancia una correzione. Dice anche di non
rilanciare `run_ticket` alla cieca su una correzione ferma: il tool non indica
quale correzione riprendere, quindi a seconda dello stato del momento il server
la riprende oppure avvia un fix nuovo. Si riprende da «Riprendi la correzione»
sul ticket.
