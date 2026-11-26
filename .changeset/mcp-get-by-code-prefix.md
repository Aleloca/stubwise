---
"@stubwise/mcp": patch
"@stubwise/claude-plugin": patch
---

`get_by_code` riconosce il prefisso del progetto da 2 a 6 caratteri, come il server: «A-12» e «ACQUIST-12» non sono codici e non chiamano il server.
