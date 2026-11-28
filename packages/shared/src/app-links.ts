/**
 * I LINK DELLA NUOVA APP, in UN posto (ritiro del web vecchio, inventario
 * `docs/plans/2026-11-27-ritiro-web-inventario.md` §1.1; design
 * `docs/plans/2026-11-27-link-nuova-app-design.md`).
 *
 * Chi scrive un link verso Stubwise (una card, un'email, una push, un webhook
 * in uscita, la risposta dell'SDK o dell'MCP, un DM Slack) lo costruisce QUI,
 * mai a mano. Dal ritiro del web vecchio (R1) l'app sta alla radice:
 * {@link APP_ENTRY} è `/`, e `/app/…` resta solo un redirect di Caddy per i
 * link già spediti. Il test di registro
 * `apps/server/src/app-links-registry.test.ts` fa fallire chi scrive a mano un
 * percorso del web vecchio o un `/#` fuori da qui.
 *
 * La grammatica è quella del router del renderer
 * (`apps/desktop/src/renderer/router.tsx`, `data/routes.ts`): le pagine di un
 * progetto vogliono il suo CODICE (`ACQ`), una task si apre col parametro
 * `?task=<CODE-n>` (valido su ogni pagina), una richiesta col suo id.
 * Una pagina che non c'è o che chi apre non vede la gestisce l'app (la sua
 * pagina «non trovato» o il progetto che non vede), non il link.
 */

/**
 * Il codice di un progetto (`ACQ`, `TRI2`, `WIL2`): una lettera e poi da 1 a 5
 * lettere o cifre. È LA regola: `projectCodeSchema` la usa, e il renderer la
 * scrive nelle sue espressioni (un test di registro lì vieta la vecchia
 * `[A-Z]{2,4}`, che lasciava fuori i codici con cifre o più lunghi).
 */
export const PROJECT_CODE_PATTERN = "[A-Z][A-Z0-9]{1,5}";

/** L'ingresso della nuova app nell'origine: la radice, dal ritiro del web vecchio (R1). */
export const APP_ENTRY = "/";

/** Una sezione delle Preferenze (`#/preferences/<sezione>`). */
export type AppPreferenceSection = "notifications" | "account" | "security" | "tokens" | "claude-code" | "look";

/** Un oggetto di Stubwise, come la nuova app lo apre. */
export type AppTarget =
  | { to: "home" }
  /** Una task: `#/p/ACQ/tasks?task=ACQ-12`. */
  | { to: "task"; projectCode: string; taskCode: string }
  /** Le richieste (il backlog) di un progetto, o una sola, per id: `#/p/ACQ/requests?request=<id>`. */
  | { to: "requests"; projectCode: string; requestId?: string }
  /** La panoramica di un progetto, eventualmente col brief aperto (`?brief=<id>`). */
  | { to: "project"; projectCode: string; briefId?: string }
  /** I membri di un progetto: `#/p/ACQ/settings/members`. */
  | { to: "projectMembers"; projectCode: string }
  /** I Docs di un progetto, di un repository (per slug) o una pagina. */
  | { to: "docs"; projectCode: string; repositorySlug?: string; pageSlug?: string }
  /** Una pagina della documentazione di prodotto: `#/p/ACQ/docs/product/ACQ-D5`. */
  | { to: "productPage"; projectCode: string; pageCode: string }
  /** Un server monitorato: `#/p/ACQ/servers/SRV-2`. */
  | { to: "server"; projectCode: string; serverCode: string }
  /** Un server senza un progetto univoco, dall'Amministrazione: `#/admin/servers/SRV-2`. */
  | { to: "adminServer"; serverCode: string }
  /** Un rilascio: `#/p/ACQ/releases/ACQ-V3`. */
  | { to: "release"; projectCode: string; releaseCode: string }
  /** Il pannello di una PR nei rilasci: `#/p/ACQ/releases?pr=<repositoryId>%23<n>`. */
  | { to: "pullRequest"; projectCode: string; repositoryId: string; prNumber: number }
  /** Un messaggio della Chat: `#/chat/<canale>?message=<id>`. */
  | { to: "chatMessage"; channelId: string; messageId: string }
  /** Un'automazione, o una sua esecuzione: `#/automations/AUD-A1(/runs/2)`. */
  | { to: "automation"; automationCode: string; runNumber?: number | null }
  /** Una sezione delle Preferenze, con una ricerca facoltativa (`?google=ok`). */
  | { to: "preferences"; section: AppPreferenceSection; search?: Record<string, string> }
  /** Le pagine fuori dall'app vera e propria (link d'accesso dalle email, ritorno di Google). */
  | { to: "resetPassword"; token: string }
  | { to: "register"; token: string }
  | { to: "emailChange"; token: string }
  | { to: "desktopGoogle"; search: Record<string, string> }
  /** La conferma nel browser del login del Mac (PKCE): `#/desktop-login?challenge&state&device`. */
  | { to: "desktopLogin"; search: Record<string, string> }
  /** Una persona nell'Amministrazione: `#/admin/people/<id>`. */
  | { to: "adminPerson"; personId: string }
  /**
   * Un indirizzo dell'app GIÀ composto dal suo router (percorso e ricerca,
   * `/projects?view=person`), per aprire nel browser la pagina che si sta
   * guardando. Deve iniziare con `/`; non è un modo per scrivere a mano un
   * indirizzo che ha già il suo bersaglio qui sopra.
   */
  | { to: "route"; route: string };

const seg = (value: string) => encodeURIComponent(value);
const query = (params: Record<string, string>) => {
  const s = new URLSearchParams(params).toString();
  return s ? `?${s}` : "";
};

/**
 * Gli slug che l'indirizzo dei Docs della nuova app usa già, e che quindi un
 * repository o una pagina non possono avere (revisione dei link, M4):
 * `#/p/<P>/docs/product` è lo spazio Prodotto, e dentro lo spazio di un
 * repository `new`, `brief`, `releases` e `graph` sono pagine dell'app
 * (`router.tsx`, figli di `/p/$code/docs/$repo`). Uno slug così prende un
 * suffisso ({@link unreservedSlug}).
 */
export const RESERVED_REPOSITORY_SLUGS: readonly string[] = ["product"];
export const RESERVED_DOC_PAGE_SLUGS: readonly string[] = ["new", "brief", "releases", "graph"];

/** Lo slug com'è, o col suffisso se è riservato (`product` → `product-repo`). */
export function unreservedSlug(slug: string, reserved: readonly string[], suffix: string): string {
  return reserved.includes(slug) ? `${slug}-${suffix}` : slug;
}

/** Il frammento dopo `#` (`/p/ACQ/tasks?task=ACQ-12`). */
export function appRoute(target: AppTarget): string {
  // Un codice di progetto vuoto (un progetto sparito, letto come `?? ""`) non
  // fa un `/p//…`: la Home (revisione dei link, M3).
  if ("projectCode" in target && !target.projectCode) return "/home";
  switch (target.to) {
    case "home":
      return "/home";
    case "task":
      return `/p/${seg(target.projectCode)}/tasks${query({ task: target.taskCode })}`;
    case "requests":
      return `/p/${seg(target.projectCode)}/requests${target.requestId ? query({ request: target.requestId }) : ""}`;
    case "project":
      return `/p/${seg(target.projectCode)}/overview${target.briefId ? query({ brief: target.briefId }) : ""}`;
    case "projectMembers":
      return `/p/${seg(target.projectCode)}/settings/members`;
    case "docs": {
      const repo = target.repositorySlug ? `/${seg(target.repositorySlug)}` : "";
      const page = target.repositorySlug && target.pageSlug ? `/${seg(target.pageSlug)}` : "";
      return `/p/${seg(target.projectCode)}/docs${repo}${page}`;
    }
    case "productPage":
      return `/p/${seg(target.projectCode)}/docs/product/${seg(target.pageCode)}`;
    case "server":
      return `/p/${seg(target.projectCode)}/servers/${seg(target.serverCode)}`;
    case "adminServer":
      return `/admin/servers/${seg(target.serverCode)}`;
    case "release":
      return `/p/${seg(target.projectCode)}/releases/${seg(target.releaseCode)}`;
    case "pullRequest":
      // `#` nel valore: `%23`, come lo legge il pannello delle PR.
      return `/p/${seg(target.projectCode)}/releases?pr=${seg(target.repositoryId)}%23${target.prNumber}`;
    case "chatMessage":
      return `/chat/${seg(target.channelId)}${query({ message: target.messageId })}`;
    case "automation":
      return `/automations/${seg(target.automationCode)}${target.runNumber != null ? `/runs/${target.runNumber}` : ""}`;
    case "preferences":
      return `/preferences/${target.section}${target.search ? query(target.search) : ""}`;
    case "resetPassword":
      return `/reset-password/${seg(target.token)}`;
    case "register":
      return `/register/${seg(target.token)}`;
    case "emailChange":
      return `/email-change/${seg(target.token)}`;
    case "desktopGoogle":
      return `/desktop-google${query(target.search)}`;
    case "desktopLogin":
      return `/desktop-login${query(target.search)}`;
    case "adminPerson":
      return `/admin/people/${seg(target.personId)}`;
    case "route":
      return target.route.startsWith("/") ? target.route : "/home";
  }
}

/** Il percorso nell'origine (`/#/p/ACQ/tasks?task=ACQ-12`), per un `Location` o un link relativo. */
export function appPath(target: AppTarget): string {
  return `${APP_ENTRY}#${appRoute(target)}`;
}

/**
 * L'indirizzo intero, con la radice pubblica dell'istanza (`PUBLIC_URL`).
 * Senza radice il link resta RELATIVO (`/#/…`): l'app lo apre lo stesso,
 * e chi non può usare un link relativo (un'email, Slack) lo controlla prima.
 */
export function appUrl(publicUrl: string | null | undefined, target: AppTarget): string {
  return `${(publicUrl ?? "").replace(/\/+$/, "")}${appPath(target)}`;
}
