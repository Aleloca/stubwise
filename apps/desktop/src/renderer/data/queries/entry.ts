import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import { DEFAULT_PERSONA_ID, VIEW_AS_PERSONAS, useViewer } from "../viewer";
import { NO_SESSION_PERSON_ID } from "../session";
import { useSessionPersonId } from "../queries";

// Gli hook dell'ingresso (area 9a, Task 6): login col secondo fattore,
// registrazione su invito, primo avvio, uscita e i due reset del prototipo.
// `data/queries` li ri-esporta. L'import circolare con `../queries` è
// innocuo: gli helper si usano solo dentro le funzioni.

// Le regole dei campi d'ingresso: le pagine le leggono da qui, non ne tengono una copia.
export { EMAIL_RE, MIN_PASSWORD_LENGTH } from "../me/account";
export { SECOND_FACTOR_MAX_FAILURES } from "../auth/reauth";
export { resetTokenOf } from "../auth/resetPassword";

export type {
  EntryStage,
  InviteLookup,
  LoginResult,
  LoginSecondFactorResult,
  RegisterResult,
  ResetLinkStatus,
  ResetPasswordResult,
  FirstAdminResult,
} from "../auth";

/**
 * Da quale porta si passa (fuori, a metà, dentro) e se l'istanza è vuota.
 * Sincrono: lo legge il cancello delle rotte a ogni render, senza latenza
 * (`readEntry`). Il valore cambia solo con una scrittura dell'ingresso, che
 * cambia persona o indirizzo: entrambi ri-renderizzano chi lo legge.
 */
export function useEntryGate() {
  // La persona entra nelle dipendenze del render: cambiarla rilegge il cancello.
  useSessionPersonId();
  return api.auth.readEntry();
}

/**
 * Entrare come qualcuno (login, registrazione, primo avvio): la persona di
 * chi guarda diventa quella, e nessuna cache di prima resta (le chiavi sono
 * per persona, ma l'ingresso cambia anche lo stato di tutti).
 */
function useEnterAs() {
  const client = useQueryClient();
  const { setPersona } = useViewer();
  return (personId: string) => {
    client.removeQueries({ queryKey: ["as"] });
    setPersona(personId);
  };
}

/** Email e password; con `stage: "in"` la persona è già quella di chi guarda. */
export function useLogin() {
  const enter = useEnterAs();
  return useMutation({
    mutationFn: api.auth.login,
    onSuccess: (r) => {
      if (r.ok && r.stage === "in") enter(r.personId);
    },
  });
}

/** Il secondo passo del login: codice, passkey o codice di backup. */
export function useLoginSecondFactor() {
  const enter = useEnterAs();
  return useMutation({
    mutationFn: api.auth.loginSecondFactor,
    onSuccess: (r) => {
      if (r.ok) enter(r.personId);
    },
  });
}

/**
 * «Sign out»: si chiude la sessione e chi guarda diventa «nessuno», che
 * resta tale finché un login non porta dentro qualcuno.
 */
export function useLogout() {
  const enter = useEnterAs();
  return useMutation({
    mutationFn: () => api.auth.logout(),
    onSuccess: () => enter(NO_SESSION_PERSON_ID),
  });
}

/** Cosa dice un link d'invito (valido, scaduto, revocato, niente). */
export function useInvite(token: string) {
  return useQuery({
    queryKey: ["entry", "invite", token],
    queryFn: () => api.auth.getInvite(token),
    // Un invito si legge una volta per visita: dopo la registrazione non vale più.
    gcTime: 0,
  });
}

/** Cosa dice un link di reset della password (valido, già usato, scaduto, niente). */
export function useResetLink(token: string) {
  return useQuery({
    queryKey: ["entry", "resetLink", token],
    queryFn: () => api.auth.getResetLink(token),
    // Come l'invito: dopo l'uso il link non vale più, si rilegge a ogni visita.
    gcTime: 0,
  });
}

/**
 * La password nuova da un link di reset. Non porta dentro: le sessioni della
 * persona si chiudono, e si entra dal login con la password nuova.
 */
export function useResetPassword() {
  return useMutation({
    mutationFn: (vars: { token: string; password: string }) =>
      api.auth.resetPassword(vars.token, { password: vars.password }),
  });
}

/**
 * Il login subito dopo la nascita di una persona. Se non riesce (un guasto
 * del livello dati) la persona esiste comunque e l'invito è consumato:
 * `signedIn: false`, e la pagina manda al login invece di dire «non creato».
 */
async function signInNewPerson(email: string, password: string): Promise<boolean> {
  try {
    const r = await api.auth.login({ email, password });
    return r.ok && r.stage === "in";
  } catch {
    return false;
  }
}

/**
 * Registrazione da invito, e subito dentro: la registrazione non apre una
 * sessione (come il server), quindi si fa il login con la password appena
 * scelta. Chi è appena nato non ha il secondo fattore, quindi entra.
 */
export function useRegister() {
  const enter = useEnterAs();
  return useMutation({
    mutationFn: async (vars: { token: string; email: string; name: string; password: string }) => {
      const r = await api.auth.register(vars.token, { name: vars.name, password: vars.password });
      if (!r.ok) return r;
      return { ...r, signedIn: await signInNewPerson(vars.email, vars.password) };
    },
    onSuccess: (r) => {
      if (r.ok && r.signedIn) enter(r.personId);
    },
  });
}

/** Il primo avvio: crea il primo full admin e lo porta dentro, come la registrazione. */
export function useCreateFirstAdmin() {
  const enter = useEnterAs();
  return useMutation({
    mutationFn: async (vars: { name: string; email: string; password: string }) => {
      const r = await api.auth.createFirstAdmin(vars);
      if (!r.ok) return r;
      return { ...r, signedIn: await signInNewPerson(vars.email, vars.password) };
    },
    onSuccess: (r) => {
      if (r.ok && r.signedIn) enter(r.personId);
    },
  });
}

/** SOLO PROTOTIPO, «Sign in as:» del login: nome ed email delle persone del «vedi come». */
export function usePrototypeAccounts() {
  const ids = VIEW_AS_PERSONAS.map((p) => p.personId);
  return useQuery({
    queryKey: ["entry", "accounts", ids.join(",")],
    queryFn: () => api.auth.prototypeAccounts(ids),
  });
}

/** SOLO PROTOTIPO, «Try an invite»: un link nuovo per un invito del seme. */
export function useSimulateInviteLink() {
  return useMutation({ mutationFn: api.auth.simulateInviteLink });
}

/** SOLO PROTOTIPO, «Pass 15 minutes» sul blocco del secondo fattore. */
export function usePassMinutes() {
  return useMutation({ mutationFn: api.auth.passMinutes });
}

/** SOLO PROTOTIPO, «Reset to empty instance»: resta solo Claude, e si va al primo avvio. */
export function useResetToEmptyInstance() {
  const client = useQueryClient();
  const { setPersona } = useViewer();
  return useMutation({
    mutationFn: () => api.auth.resetToEmptyInstance(),
    onSuccess: () => {
      client.clear();
      setPersona(NO_SESSION_PERSON_ID);
    },
  });
}

/**
 * SOLO PROTOTIPO, «Reset prototype»: il seme di nuovo, dentro come la
 * persona di partenza. Sincrono come `resetApi`.
 */
export function useResetPrototype() {
  const client = useQueryClient();
  const { setPersona } = useViewer();
  return () => {
    api.resetApi();
    client.clear();
    setPersona(DEFAULT_PERSONA_ID);
  };
}
