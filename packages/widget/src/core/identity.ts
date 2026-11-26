/**
 * Area 8, «L'API per i siti»: il token d'identità del cliente, che il BACKEND
 * del sito firma col segreto del widget (mai il browser: il segreto non sta
 * mai in una pagina). Il widget lo riceve già firmato, come stringa o come
 * funzione che lo procura (e lo rinnova quando scade).
 */
export type IdentityTokenOption = string | (() => string | Promise<string>);

export interface IdentitySource {
  /** Il token da mandare; `refresh` ne chiede uno nuovo (dopo un 401 `invalid_identity`). */
  token(refresh?: boolean): Promise<string>;
}

/** Una stringa vale sempre; una funzione si chiama una volta e si richiama solo al rinnovo. */
export function createIdentitySource(option: IdentityTokenOption): IdentitySource {
  if (typeof option === "string") return { token: async () => option };
  let cached: Promise<string> | null = null;
  return {
    token(refresh = false) {
      if (refresh || cached === null) {
        cached = Promise.resolve().then(option);
        // Un errore del sito non resta in cache: la prossima chiamata riprova.
        cached.catch(() => {
          cached = null;
        });
      }
      return cached;
    },
  };
}
