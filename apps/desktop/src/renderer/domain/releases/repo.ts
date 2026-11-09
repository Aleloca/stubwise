/** Il nome corto di un repository (`owner/repo` → `repo`), come lo dicono righe e testi. */
export const shortRepo = (repo: string): string => repo.slice(repo.indexOf("/") + 1);
