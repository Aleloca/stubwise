/**
 * Se una risposta dice che la SESSIONE è finita (integrazione area 2, fetta 1:
 * la build app e il proxy del desktop). Non ogni 401: il server risponde 401
 * anche a richieste applicative — un codice di riconferma sbagliato
 * (`invalid_second_factor`), credenziali sbagliate (`invalid_credentials`) —
 * con la sessione viva. È finita solo col codice dell'hook d'autenticazione
 * (`unauthorized`), con quello del proxy del desktop senza token
 * (`unauthenticated`), o con un 401 qualunque su `/api/auth/me`, che chiede
 * proprio chi è dentro.
 */
export function endsSession(path: string, status: number, code: string | undefined): boolean {
  if (status !== 401) return false;
  if (code === "unauthorized" || code === "unauthenticated") return true;
  return path.split("?")[0] === "/api/auth/me";
}
