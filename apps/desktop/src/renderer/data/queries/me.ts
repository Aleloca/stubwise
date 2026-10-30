import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import type { GoogleConnectOutcome } from "../me/types";
import { GOOGLE_AREAS, queryKeys, useInvalidate, useSessionPersonId } from "../queries";

// Gli hook delle Preferenze personali (area 9a, Task 7): Account, le caselle
// Google, Security, Tokens, Claude Code. `data/queries` li ri-esporta.
// L'import circolare con `../queries` è innocuo: gli helper si usano solo
// dentro le funzioni.
//
// I segreti (token, comando, chiave TOTP, codici di backup) arrivano nel
// risultato di una mutazione e stanno SOLO nello stato della sezione che li
// mostra (`SecretOnce`): le loro mutazioni hanno `gcTime: 0`, così la cache
// delle mutazioni non li tiene dopo che la pagina li ha lasciati.

export type {
  GoogleConnectOutcome,
  MyMailbox,
  MyMailboxes,
  MySecurity,
  MyProfile,
  TokenView,
} from "../me";

/** Le aree che una scrittura delle Preferenze ricarica: «me» e la riconferma («admin»). */
const ME_AREAS = ["me", "admin"] as const;

function useMeWrite<TVars, TData>(
  mutationFn: (vars: TVars) => Promise<TData>,
  areas: readonly string[] = ME_AREAS,
  { secret = false }: { secret?: boolean } = {},
) {
  const invalidate = useInvalidate(areas);
  return useMutation({ mutationFn, onSettled: invalidate, ...(secret ? { gcTime: 0 } : {}) });
}

// --- Account -----------------------------------------------------------------

/** Nome, email d'accesso, foto e reparto di chi guarda. */
export function useMyProfile() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.me(me, "profile"), queryFn: () => api.me.getMyProfile() });
}

/**
 * Nome, email o foto: il nome si vede ovunque (task, registro, «vedi come»,
 * binario), quindi alla fine si ricarica tutto di chi guarda.
 */
export function useUpdateProfile() {
  const client = useQueryClient();
  const me = useSessionPersonId();
  return useMutation({
    mutationFn: (input: api.me.ProfileInput) => api.me.updateProfile(input),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.all(me) }),
  });
}

/** Cambia la password: chiude le altre sessioni (Security le rilegge). */
export function useChangePassword() {
  return useMeWrite((input: { current: string; next: string }) => api.me.changePassword(input));
}

// --- Caselle Google ----------------------------------------------------------

/**
 * Le caselle sono le stesse di Posta, Calendario e Drive: le scritture
 * ricaricano anche loro. Una funzione, non una costante: l'import circolare
 * con `../queries` non è ancora risolto quando questo modulo si carica.
 */
const mailboxAreas = (): readonly string[] => ["me", ...GOOGLE_AREAS];

export function useMyMailboxes() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.me(me, "mailboxes"),
    queryFn: () => api.me.listMyMailboxes(),
  });
}

/** Collega una casella; `outcome` è la risposta di Google scelta nel riquadro «Prototype only». */
export function useConnectMailbox() {
  return useMeWrite(
    ({ workspaceId, outcome }: { workspaceId: string; outcome: GoogleConnectOutcome }) =>
      api.me.connectMailbox(workspaceId, outcome),
    mailboxAreas(),
  );
}

export function useReconnectMailbox() {
  return useMeWrite(
    ({ id, outcome }: { id: string; outcome: GoogleConnectOutcome }) =>
      api.me.reconnectMailbox(id, outcome),
    mailboxAreas(),
  );
}

export function useDisconnectMailbox() {
  return useMeWrite((id: string) => api.me.disconnectMailbox(id), mailboxAreas());
}

/** L'interruttore «Proposals»: lo stesso della Posta. */
export function useSetMailboxProposals() {
  return useMeWrite(
    ({ id, on }: { id: string; on: boolean }) => api.me.setProposals(id, on),
    mailboxAreas(),
  );
}

// --- Security ----------------------------------------------------------------

/** Il secondo fattore, le passkey, i codici rimasti, le sessioni e il registro. */
export function useMySecurity() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.me(me, "security"),
    queryFn: () => api.me.getMySecurity(),
  });
}

/** Riconfigura l'app di autenticazione (+R): la chiave, una volta. */
export function useStartTotpSetup() {
  return useMeWrite(() => api.me.startTotpSetup(), ME_AREAS, { secret: true });
}

/**
 * La prima configurazione (chi non ha il secondo fattore, come Sara): la
 * stessa strada dell'iscrizione al volo, senza riconferma (non c'è ancora
 * niente con cui riconfermarsi).
 */
export function useStartFirstTotpSetup() {
  return useMeWrite(() => api.auth.enrollDuringReauth(), ME_AREAS, { secret: true });
}

/** Il primo codice dell'app: alla prima attivazione arrivano i codici di backup, una volta. */
export function useConfirmTotp() {
  return useMeWrite((code: string) => api.me.confirmTotp(code), ME_AREAS, { secret: true });
}

/** Aggiunge una passkey (+R); `simulate` è la risposta del browser nel prototipo. */
export function useAddPasskey() {
  return useMeWrite(({ name, simulate }: { name: string; simulate: "ok" | "fail" }) =>
    api.me.addPasskey(name, simulate),
  );
}

export function useRenamePasskey() {
  return useMeWrite(({ id, name }: { id: string; name: string }) => api.me.renamePasskey(id, name));
}

export function useRemovePasskey() {
  return useMeWrite((id: string) => api.me.removePasskey(id));
}

/** Codici di backup nuovi (+R): i vecchi smettono subito di valere. */
export function useRegenerateBackupCodes() {
  return useMeWrite(() => api.me.regenerateBackupCodes(), ME_AREAS, { secret: true });
}

/** «Sign out» da un'altra sessione. */
export function useEndSession() {
  return useMeWrite((id: string) => api.me.endSession(id));
}

// --- Tokens e Claude Code ----------------------------------------------------

/** I miei token: mai il valore. */
export function useMyTokens() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.me(me, "tokens"), queryFn: () => api.me.listTokens() });
}

/** Crea un token (+R): il valore torna una volta. */
export function useCreateToken() {
  return useMeWrite(
    (input: { name: string; expiresAt: string | null }) => api.me.createToken(input),
    ME_AREAS,
    { secret: true },
  );
}

export function useRevokeToken() {
  return useMeWrite((id: string) => api.me.revokeToken(id));
}

/** Il comando di Claude Code (+R) col suo token nuovo: una volta. */
export function useCreateClaudeCodeCommand() {
  return useMeWrite(() => api.me.createClaudeCodeCommand(), ME_AREAS, { secret: true });
}
