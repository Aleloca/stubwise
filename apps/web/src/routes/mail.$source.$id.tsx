import { getRouteApi } from "@tanstack/react-router";
import { MailWorkspace } from "../components/mail-workspace";

const route = getRouteApi("/authed/mail/$source/$id");

/**
 * `/mail/:source/:id` (fase 9, Task 5): la STESSA posta a tre colonne di
 * `/mail` (`MailWorkspace`), con il messaggio del path già selezionato — la
 * lista al centro resta visibile, non si naviga più via da lei per leggere
 * un messaggio. `source` è `"email" | "email_triage"` (mai `"calendar"`: il
 * calendario non ha un estratto né un messaggio Gmail — la sua vista è
 * `/calendar`).
 */
export function MailDetailPage() {
  const { source, id } = route.useParams();
  const detailSource = source === "email_triage" ? "email_triage" : "email";
  return <MailWorkspace selected={{ source: detailSource, id }} />;
}
