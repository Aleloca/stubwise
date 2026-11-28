/**
 * La parità dell'MCP con l'app (design `docs/plans/2026-11-26-mcp-parita-design.md`
 * § 2): ogni rotta del registro dice, in `config.mcp`, se è un'AZIONE del
 * catalogo che `@stubwise/mcp` offre col PAT, o perché ne resta fuori.
 *
 * Tre esclusioni NON si dichiarano: le dà il registro stesso
 * ({@link impliedMcpExclusion}).
 * - `reauth`: `config.reauth`, che un PAT non soddisfa mai.
 * - `vault`: le flag della cassaforte (`browserOnly`, `desktopVault`,
 *   `desktopOnly`, `desktopRead`).
 * - `login`: le porte del login (`second_factor`, `credentialDoor`).
 * Così un'esclusione «comoda» non si può scrivere, e una flag nuova esclude da
 * sola. Su queste rotte un'`action` fa fallire `mcp-parity.test.ts`: sarebbe
 * una voce del catalogo che fallisce sempre.
 */
export type RouteMcp = RouteMcpAction | RouteMcpExclusion;

export interface RouteMcpAction {
  /** `area.verbo` (`tasks.update`), unico nel registro. */
  action: string;
  /** In italiano, una frase: cosa fa, e per chi. */
  summary: string;
  /** `GET` ⇒ `read`, `DELETE` ⇒ `destructive`; le altre scritture `write` o `destructive`. */
  effect: "read" | "write" | "destructive";
  /** Il tool curato che la serve (decisioni, file): `write_action` la rifiuta. */
  tool?: string;
  /** Ciò che il modello deve sapere prima di chiamarla (riconferma parziale, invii fuori…). */
  note?: string;
  /**
   * I percorsi della risposta che l'MCP nasconde prima di mostrarla, oltre ai
   * nomi di `packages/mcp/src/tools/redact.ts`: un segreto con un nome comune
   * (l'`url` di un webhook in uscita, una credenziale al portatore). Forma:
   * `url`, `[].url`, `items.[].url`. Revisione del lotto 6 (I2).
   */
  redact?: readonly string[];
  /**
   * `mcp`: la rotta è superficie PROPRIA dell'MCP (D10, decisione del
   * maintainer del 28 nov 2026): la servono i tool dedicati di Claude Code
   * (`packages/mcp`, i comandi del plugin) e l'app non la chiama, per scelta.
   * Resta anche dopo il ritiro del web vecchio; lo script delle rotte non la
   * conta fra quelle «senza chiamanti». Elenco chiuso
   * (`src/mcp/mcp-owned.test.ts`).
   */
  owner?: "mcp";
}

export interface RouteMcpExclusion {
  exclude: DeclaredMcpExclusion;
  /** Con `stream`: l'`action` della lettura che lo sostituisce (obbligatoria). */
  instead?: string;
}

/**
 * Le esclusioni che si DICHIARANO (elenco chiuso, verificato dal test):
 * - `vault`: una rotta di `/api/vault` o `/api/credentials` che il PAT passa
 *   ma che dà o chiede materiale cifrato (la cassaforte, eccezione 1);
 * - `login`: una rotta pubblica di `/api/auth` (setup, inviti, reset, logout);
 * - `inbound`: una rotta pubblica con la sua autenticazione (webhook in
 *   ingresso, widget, agente di monitoraggio, Slack, callback OAuth);
 * - `infra`: una rotta pubblica d'infrastruttura (`/health`, la spec OpenAPI);
 * - `stream`: SSE, con `instead`;
 * - `desktop_link`: le rotte del PAT dell'app desktop;
 * - `session_only`: una rotta che rifiuta il PAT NEL SUO HANDLER senza
 *   dichiarare `config.reauth` (la riconferma dell'identità stessa: elenco
 *   chiuso, contato sul sorgente);
 * - `app_only`: una rotta dell'app mobile che da Claude Code non serve e
 *   sarebbe un vettore (registrare il token push di un telefono lo intesta a
 *   chi lo registra: un'istruzione iniettata dirotterebbe le notifiche).
 *   Elenco chiuso, revisione del lotto 6 (I2);
 * - `secret_once`: una rotta il cui scopo è RESTITUIRE un segreto in chiaro
 *   (la chiave di un agente di monitoraggio appena creata o rigenerata):
 *   decisione del maintainer, si fa solo dall'app (elenco chiuso). Un segreto
 *   che viaggia DENTRO una lettura ordinaria (la chiave d'ingestione di un
 *   progetto) non esclude la rotta: l'MCP lo nasconde prima di mostrarlo
 *   (`packages/mcp/src/tools/redact.ts`), e il test di parità pretende che
 *   ogni campo dall'aria segreta di un'azione sia nascosto o dichiarato
 *   innocuo;
 * - `chat_tool`: le rotte di scrittura del SOLO token del turno di Claude
 *   (`CHAT_TOOL_WRITE_ROUTES` di `@stubwise/shared`, elenco chiuso): a una
 *   persona rispondono 403 `claude_only`, quindi una voce del catalogo
 *   fallirebbe sempre (lotto 4, decisione di 46).
 */
export type DeclaredMcpExclusion = "vault" | "login" | "inbound" | "infra" | "stream" | "desktop_link" | "session_only" | "secret_once" | "app_only" | "chat_tool";

/** Le esclusioni che dà il registro (vedi il docblock del file). */
export type ImpliedMcpExclusion = "reauth" | "vault" | "login";

/** Ciò che serve della config di una rotta per decidere l'esclusione implicita. */
export interface McpRouteFacts {
  accessKind?: string;
  reauth?: unknown;
  browserOnly?: unknown;
  desktopVault?: unknown;
  desktopOnly?: unknown;
  desktopRead?: unknown;
  credentialDoor?: unknown;
}

export function impliedMcpExclusion(facts: McpRouteFacts): ImpliedMcpExclusion | null {
  if (facts.browserOnly || facts.desktopVault || facts.desktopOnly || facts.desktopRead) return "vault";
  if (facts.accessKind === "second_factor" || facts.credentialDoor) return "login";
  if (facts.reauth) return "reauth";
  return null;
}

export function isMcpAction(mcp: RouteMcp | undefined): mcp is RouteMcpAction {
  return mcp !== undefined && "action" in mcp;
}
