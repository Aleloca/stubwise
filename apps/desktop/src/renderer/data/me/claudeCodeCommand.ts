// Il comando d'installazione di Claude Code e il nome del suo token (area 9a;
// area 9, R4c): funzioni PURE, senza stato del prototipo, così le usa anche
// la build app (`data/backend/real/meTokens.ts`) senza portarsi dietro il seme.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Il comando, nella stessa forma del web (`buildInstallCommand` di
 * `apps/web/src/routes/settings/claude-code.tsx`): marketplace, plugin,
 * poi `setup` per ultimo, con l'url dell'istanza e il token.
 */
export function buildInstallCommand(url: string, token: string): string {
  return `claude plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins && claude plugin install stubwise@stubwise && npx -y @stubwise/mcp@latest setup --url ${url} --token ${token}`;
}

/** Il nome del token del comando: «Claude Code · Oct 29». */
export function claudeCodeTokenName(at: string): string {
  const d = new Date(at);
  return `Claude Code · ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
