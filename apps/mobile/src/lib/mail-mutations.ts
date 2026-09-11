import { ApiError } from "@stubwise/api-client";
import type { MailDetailSource, MailFilters, MailReproposeSource } from "@stubwise/api-client";
import { isUnknown } from "@stubwise/shared";
import type { MailItem, MailItemStatus, Reader, Unknown } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useAuth } from "../app/providers";
import { useIsOnline } from "./inbox-mutations";
import type { PulseTone } from "./pulse-line";

export const mailKeys = {
  all: ["mail"] as const,
  list: (filters: MailFilters) => [...mailKeys.all, "list", filters] as const,
  detail: (source: MailDetailSource, id: string) => [...mailKeys.all, "detail", source, id] as const,
};

/**
 * Da quale `source` (e — per l'email — quale `MailDetailSource`) apre il
 * dettaglio di una riga, secondo `mailItemKindSchema`
 * (`packages/shared/src/schemas/google.ts`): `null` per il calendario, che
 * non ha un dettaglio (i suoi campi sono già tutti nella riga, vedi il
 * docblock di `MailDetailSource` in `@stubwise/api-client`) — `"email"` per
 * una proposta vera, `"email_triage"` per il PADRE di uno smistamento
 * (`kind: "triage"`), che vive su `email_messages`, non su `email_proposals`.
 *
 * Riceve `Reader<MailItem>` (la lista passa da `readerSchema`): `source`
 * `UNKNOWN` — un valore futuro che questa build non riconosce — degrada a
 * `null`, MAI a un tentativo di apertura su una sorgente che non sappiamo
 * interpretare; `kind` `UNKNOWN` degrada invece a `"email"`, lo stesso
 * default del server (`.optional().default("proposal")`, mai `"triage"`).
 */
export function mailDetailSourceFor(item: Reader<MailItem>): MailDetailSource | null {
  if (isUnknown(item.source) || item.source === "calendar") return null;
  return item.kind === "triage" ? "email_triage" : "email";
}

/**
 * Stessa disambiguazione di {@link mailDetailSourceFor}, per
 * `POST /:source/:id/repropose` (ammette anche `"calendar"`) — `null` solo
 * quando `source` è `UNKNOWN`.
 */
export function mailReproposeSourceFor(item: Reader<MailItem>): MailReproposeSource | null {
  if (isUnknown(item.source)) return null;
  if (item.source === "calendar") return "calendar";
  return item.kind === "triage" ? "email_triage" : "email";
}

/** Etichetta i18n dello stato di una riga (canvas: Aperta / Gestita / Ignorata / Fallita…). */
const MAIL_STATUS_LABEL_KEYS: Record<MailItemStatus, string> = {
  new: "mobile.mbx.status.new",
  classified: "mobile.mbx.status.classified",
  proposed: "mobile.mbx.status.proposed",
  actioned: "mobile.mbx.status.actioned",
  ignored: "mobile.mbx.status.ignored",
  failed: "mobile.mbx.status.failed",
  cancelled: "mobile.mbx.status.cancelled",
};

/**
 * Tono del pallino di stato: `"signal"` per ciò che chiede attenzione
 * (`proposed` — una proposta aperta — e `failed` — qualcosa da riproporre),
 * `"ok"` per ciò che è stato gestito, `"faint"` per il resto (non ancora
 * classificato, ignorato, o una serie di calendario cancellata).
 */
const MAIL_STATUS_TONE: Record<MailItemStatus, PulseTone> = {
  new: "faint",
  classified: "faint",
  proposed: "signal",
  actioned: "ok",
  ignored: "faint",
  failed: "signal",
  cancelled: "faint",
};

/** Stesso pattern di `backlogStatusLabelKey`/`backlogStatusTone`: uno stato letto da `Reader<MailItemStatus>` può essere `UNKNOWN` (server più nuovo). */
export function mailStatusLabelKey(status: MailItemStatus | Unknown): string {
  return isUnknown(status) ? "mobile.mbx.status.unknown" : MAIL_STATUS_LABEL_KEYS[status];
}

export function mailStatusTone(status: MailItemStatus | Unknown): PulseTone {
  return isUnknown(status) ? "faint" : MAIL_STATUS_TONE[status];
}

/**
 * Messaggio d'errore della Posta, dal solo `code` — stessa dottrina di
 * `describeInboxError` (mai da `error.message`, inglese e non contratto).
 * `message_gone`/`token_expired`/`google_unavailable` sono i tre errori VERI
 * di «mostra l'originale» (design fase 7b/9): il messaggio è sparito da
 * Gmail, la casella va ricollegata, Google non risponde in questo momento —
 * in ognuno dei tre casi l'ESTRATTO resta leggibile, questo messaggio si
 * mostra solo accanto al bottone «Mostra l'originale», mai al posto della
 * card intera. `not_reproposable` è l'unico errore vero di «riproponi».
 */
export function describeMailError(error: unknown, t: TFunction): string {
  if (!(error instanceof ApiError)) return t("mobile.mbx.errors.generic");
  switch (error.code) {
    case "message_gone":
      return t("mobile.mbx.errors.messageGone");
    case "token_expired":
      return t("mobile.mbx.errors.tokenExpired");
    case "google_unavailable":
      return t("mobile.mbx.errors.googleUnavailable");
    case "not_reproposable":
      return t("mobile.mbx.errors.notReproposable");
    default:
      return t("mobile.mbx.errors.generic");
  }
}

/** Lista Posta (design: corta per costruzione, nessuna paginazione infinita — vedi `MbxScreen.tsx`). */
export function useMailList(filters: MailFilters = {}) {
  const { client } = useAuth();
  return useQuery({
    queryKey: mailKeys.list(filters),
    queryFn: () => {
      if (!client) throw new Error("useMailList richiede un client autenticato");
      return client.mail.list(filters);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });
}

/** Dettaglio dall'ESTRATTO già in database (design fase 7b §3): mai a token scaduto o Google giù. */
export function useMailDetail(source: MailDetailSource, id: string) {
  const { client } = useAuth();
  return useQuery({
    queryKey: mailKeys.detail(source, id),
    queryFn: () => {
      if (!client) throw new Error("useMailDetail richiede un client autenticato");
      return client.mail.get(source, id);
    },
    enabled: client !== null,
  });
}

/**
 * Il messaggio ORIGINALE, riletto da Gmail SU RICHIESTA — una `useMutation`
 * (non una `useQuery` `enabled`) perché il tap su «Mostra l'originale» è
 * un'azione esplicita, non qualcosa che deve ripartire da solo (un refetch
 * automatico rileggerebbe Gmail senza che l'utente l'abbia chiesto di nuovo).
 */
export function useMailOriginal(source: MailDetailSource, id: string) {
  const { client } = useAuth();
  const { t } = useTranslation();
  const mutation = useMutation({
    mutationFn: () => {
      if (!client) throw new Error("useMailOriginal richiede un client autenticato");
      return client.mail.original(source, id);
    },
  });
  return {
    load: () => mutation.mutate(),
    data: mutation.data ?? null,
    isPending: mutation.isPending,
    errorMessage: mutation.error ? describeMailError(mutation.error, t) : null,
    reset: mutation.reset,
  };
}

export interface MailReproposeMutation {
  mutate: () => void;
  isPending: boolean;
  disabled: boolean;
  online: boolean;
  errorMessage: string | null;
  reset: () => void;
}

/** «Riproponi» una riga `failed`/`ignored`: resetta lo stato, non pubblica una proposta nuova da qui (il prossimo tick del poller la riprende). */
export function useRepropose(source: MailReproposeSource, id: string): MailReproposeMutation {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const { t } = useTranslation();
  const mutation = useMutation({
    mutationFn: () => {
      if (!client) throw new Error("useRepropose richiede un client autenticato");
      return client.mail.repropose(source, id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
  return {
    mutate: () => mutation.mutate(),
    isPending: mutation.isPending,
    disabled: !online || mutation.isPending,
    online,
    errorMessage: mutation.error ? describeMailError(mutation.error, t) : null,
    reset: mutation.reset,
  };
}
