/**
 * Area 9, F5 (decisioni C e D): un segreto che il server dà UNA volta — la
 * chiave d'ingestione alla creazione del progetto, il segreto del webhook
 * alla creazione del repository — portato dalla pagina che crea a quella di
 * dettaglio, dove si mostra.
 *
 * In MEMORIA, mai nello stato di history: `history.state` sopravvive a un
 * reload e finisce nella sessione del browser, e un segreto non deve
 * restarci. Chi lo legge usa {@link peekOneTimeSecret} nell'inizializzatore
 * dello stato e {@link dropOneTimeSecret} in un effetto: in StrictMode
 * l'inizializzatore gira due volte, e una lettura che consuma darebbe alla
 * seconda niente.
 */
const secrets = new Map<string, string>();

export function stashOneTimeSecret(key: string, value: string | null | undefined): void {
  if (value) secrets.set(key, value);
}

export function peekOneTimeSecret(key: string): string | null {
  return secrets.get(key) ?? null;
}

export function dropOneTimeSecret(key: string): void {
  secrets.delete(key);
}
