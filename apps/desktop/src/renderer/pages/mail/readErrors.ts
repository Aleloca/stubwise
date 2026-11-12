import { useTranslation } from "react-i18next";
import { useToast } from "../../tasks-ui/Toast";
import { openGoogleAccount } from "../drive/GoogleAccountCard";

// Letto / non letto si scrive su Gmail (area 6, F1.3): quando non riesce lo
// si dice. Senza il permesso nuovo o con la casella scaduta, «Ricollega»
// apre il cassetto; Gmail occupato, «riprova fra poco»; il resto, un errore
// generico. La lettura AUTOMATICA (dopo 1 s di permanenza) lo dice una volta
// per sessione e casella: aprire una conversazione dopo l'altra non deve
// ripetere lo stesso avviso.

const RECONNECT = new Set(["google_scope_missing", "google_not_connected"]);

/** Le caselle (e il motivo) di cui la lettura automatica ha già avvisato, in questa sessione. */
const toldAuto = new Set<string>();

export function useReadStateError(): (error: unknown, opts: { auto: boolean; mailbox?: string }) => void {
  const { t } = useTranslation();
  const toast = useToast();
  return (error, { auto, mailbox }) => {
    const code = error instanceof Error ? error.message : "";
    const kind = RECONNECT.has(code) ? "reconnect" : code === "google_rate_limited" ? "busy" : "failed";
    if (auto) {
      const key = `${mailbox ?? ""}|${kind}`;
      if (toldAuto.has(key)) return;
      toldAuto.add(key);
    }
    if (kind === "reconnect") {
      toast.error(t("mail.readState.reconnect"), {
        action: { label: t("mail.sync.reconnect"), run: () => openGoogleAccount() },
      });
    } else toast.error(t(kind === "busy" ? "mail.readState.busy" : "mail.readState.failed"));
  };
}
