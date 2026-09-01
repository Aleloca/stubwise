import { execa } from "execa";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fetch di un repo git PUBBLICO a un ref preciso, per la materializzazione dei
 * plugin del registro.
 *
 * Perché non `MirrorManager`: quello serve i repo dei progetti ed è costruito
 * intorno all'auth (header `Authorization` iniettato a ogni invocazione) e ai
 * mirror bare persistenti. Qui l'assenza di auth è un REQUISITO: un plugin è
 * codice di terze parti che gira dentro i run, e la sua sorgente deve essere
 * pubblica e verificabile da chiunque. `GIT_TERMINAL_PROMPT=0` più
 * `credential.helper` svuotato assicurano che non esista nessuna strada per
 * cui git prenda credenziali (prompt, helper del sistema, keychain): un repo
 * privato fallisce, non si autentica di nascosto. Sulla stessa linea
 * l'allowlist dei protocolli (`allowedProtocols`, default solo `https`): la
 * sorgente non può essere un trasporto che esegue comandi né un path locale.
 *
 * Il risultato è una directory di soli file (niente `.git`): il CLI di Claude
 * carica la dir come plugin, e un repo git dentro un plugin sarebbe sia peso
 * inutile sia una sorgente di confusione (un `git status` dell'agente).
 */

/** Errore di `fetchAtRef`: messaggio già redatto, pronto per DB e UI. */
export class PluginGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginGitError";
  }
}

export interface FetchAtRefOptions {
  /**
   * Budget COMPLESSIVO in millisecondi, non per singolo comando: i comandi git
   * condividono una scadenza, così il tentativo di fallback non può raddoppiare
   * il tempo che il poller ha concesso al job.
   */
  timeoutMs: number;
  /**
   * Protocolli git ammessi. Default `["https"]`: l'UNICO che il registro
   * accetta, ed è il valore che deve valere in produzione — il poller non passa
   * questo campo.
   *
   * L'allowlist è applicata a git stesso (`protocol.allow=never` più
   * `protocol.<p>.allow=always`), non solo controllata sulla stringa: così
   * cadono anche i trasporti che eseguono comandi (`ext::sh -c ...`) e i path
   * locali, che `assertNotOption` da solo lascerebbe passare.
   *
   * L'override esiste per i TEST, che usano repo locali (trasporto `file`):
   * allargare il default per farli passare significherebbe spedire in
   * produzione una superficie che non serve a nessuno.
   */
  allowedProtocols?: string[];
}

export interface FetchAtRefResult {
  /** Sha completo del commit materializzato (il pin salvato nel registro). */
  sha: string;
}

/** Ultimi caratteri di stderr riportati nell'errore: il resto è rumore. */
const MAX_STDERR_CHARS = 500;

/**
 * Redige le credenziali eventualmente presenti in un URL git. Lo schema del
 * registro rifiuta già gli URL con userinfo, ma questo helper è l'ultima
 * barriera prima del DB e della UI: la redazione è testuale e generica
 * (`<schema>://<userinfo>@` → `<schema>://[REDACTED]@`) proprio perché deve
 * valere anche su stringhe che non abbiamo composto noi, come lo stderr di git.
 */
function redact(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g, "$1[REDACTED]@");
}

/**
 * Rifiuta gli argomenti che git leggerebbe come opzioni (`--upload-pack=...` è
 * esecuzione di comandi arbitrari). Vale sia per l'URL sia per il ref: entrambi
 * arrivano dal registro, cioè da un admin, ma un controllo qui costa nulla e
 * rende l'helper sicuro da chiamare anche da altri punti.
 */
function assertNotOption(value: string, label: string): void {
  if (value.length === 0 || value.startsWith("-")) {
    throw new PluginGitError(`${label} non valido: ${redact(value)}`);
  }
}

/** Solo `https` in produzione: vedi `FetchAtRefOptions.allowedProtocols`. */
const DEFAULT_ALLOWED_PROTOCOLS = ["https"];

/**
 * Traduce l'allowlist in opzioni `-c` per git: tutto vietato per default, poi
 * riabilitati uno per uno i protocolli richiesti.
 */
function protocolArgs(protocols: string[]): string[] {
  const args = ["-c", "protocol.allow=never"];
  for (const protocol of protocols) {
    // I nomi finiscono dentro una chiave di configurazione: si accetta solo la
    // forma di uno schema, mai una stringa arbitraria.
    if (!/^[a-z][a-z0-9+.-]*$/.test(protocol)) {
      throw new PluginGitError(`Protocollo non valido: ${protocol}`);
    }
    args.push("-c", `protocol.${protocol}.allow=always`);
  }
  return args;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  /** stderr redatto e troncato (vuoto se il comando è andato a buon fine). */
  stderr: string;
  /** Descrizione del fallimento pronta per un messaggio d'errore. */
  reason: string;
}

/** Esegue un comando git dentro la checkout, senza auth e entro la scadenza. */
type GitRunner = (args: string[]) => Promise<GitResult>;

/**
 * Costruisce il runner: `cwd`, scadenza condivisa e allowlist dei protocolli
 * sono fissati una volta sola, così nessuna chiamata può dimenticarseli.
 * Non lancia mai: i fallimenti tornano come `GitResult`.
 */
function makeGitRunner(cwd: string, deadline: number, protocols: string[]): GitRunner {
  const configArgs = [
    // `credential.helper=` (valore vuoto) AZZERA la lista di helper ereditata
    // dalla config di sistema/utente: nemmeno un helper configurato sull'host
    // può fornire credenziali a questo fetch. `core.askPass=` fa lo stesso con
    // l'eventuale programma di prompt.
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    ...protocolArgs(protocols),
  ];

  return async (args: string[]): Promise<GitResult> => {
    // Almeno 1ms: execa con timeout 0 non applicherebbe nessun limite.
    const timeout = Math.max(1, deadline - Date.now());
    try {
      const { stdout } = await execa("git", [...configArgs, ...args], {
        cwd,
        timeout,
        env: {
          // Mai un prompt: un worker appeso su una richiesta di password è
          // peggio di un job fallito.
          GIT_TERMINAL_PROMPT: "0",
          // Un askpass ereditato dall'ambiente avrebbe la precedenza sulla
          // config: svuotarlo lo fa ignorare da git (che testa il valore, non
          // la presenza). Con helper e askpass fuori gioco resta una sola
          // strada: URL pubblico o errore.
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
        },
      });
      return { ok: true, stdout: stdout.trim(), stderr: "", reason: "" };
    } catch (error) {
      const e = error as { exitCode?: number; stderr?: unknown; timedOut?: boolean };
      const stderr = redact(
        typeof e.stderr === "string" ? e.stderr.slice(-MAX_STDERR_CHARS) : "",
      ).trim();
      const reason =
        e.timedOut === true ? `timeout dopo ${timeout}ms` : `git exit ${e.exitCode ?? "?"}`;
      return { ok: false, stdout: "", stderr, reason };
    }
  };
}

/** Messaggio d'errore uniforme: comando redatto, motivo, stderr redatto. */
function fail(what: string, url: string, ref: string, result: GitResult): PluginGitError {
  const details = result.stderr.length > 0 ? `\n${result.stderr}` : "";
  return new PluginGitError(
    `${what} di "${redact(ref)}" da ${redact(url)} fallito (${result.reason})${details}`,
  );
}

/**
 * Materializza `url` al `ref` indicato dentro `destDir` (creata se assente) e
 * restituisce lo sha del commit.
 *
 * Strategia: si prova un `fetch --depth 1` (una sola commit scaricata: i plugin
 * sono piccoli ma i loro repo non sempre). Se fallisce si ripiega su un fetch
 * COMPLETO di branch e tag: il caso tipico è un ref-sha, che diversi server
 * rifiutano in shallow ("server does not allow request for unadvertised
 * object") ma che è raggiungibile dai branch; la stessa strada copre anche i
 * transport che non supportano affatto lo shallow, dove il ref è un branch e
 * viene risolto come `origin/<ref>`.
 *
 * Ogni errore è un `PluginGitError` con messaggio già redatto: il chiamante può
 * catturare solo quello e scriverlo nel registro.
 */
export async function fetchAtRef(
  url: string,
  ref: string,
  destDir: string,
  options: FetchAtRefOptions,
): Promise<FetchAtRefResult> {
  assertNotOption(url, "URL sorgente");
  assertNotOption(ref, "ref");

  const deadline = Date.now() + options.timeoutMs;
  const git = makeGitRunner(
    destDir,
    deadline,
    options.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS,
  );

  try {
    await mkdir(destDir, { recursive: true });
  } catch (error) {
    throw new PluginGitError(`Creazione della directory ${destDir} fallita: ${describe(error)}`);
  }

  const init = await git(["init", "-q", "-b", "main"]);
  if (!init.ok) throw fail("Init", url, ref, init);

  const shallow = await git(["fetch", "--depth", "1", "--no-tags", url, ref]);

  let target = "FETCH_HEAD";
  if (!shallow.ok) {
    // Fallback: scarica tutti i branch e i tag, poi risolvi il ref localmente.
    const full = await git([
      "fetch",
      url,
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/tags/*:refs/tags/*",
    ]);
    if (!full.ok) {
      // Si riporta l'errore del fetch completo (l'ultimo tentativo) con anche
      // il motivo del primo: su un ref inesistente è il messaggio dello shallow
      // ("couldn't find remote ref") a spiegare davvero cosa è andato storto.
      const error = fail("Fetch", url, ref, full);
      throw new PluginGitError(
        `${error.message}\n(fetch shallow: ${shallow.reason} ${shallow.stderr})`.trim(),
      );
    }
    // `<ref>` copre sha e tag, `origin/<ref>` i nomi di branch. `^{commit}`
    // sbuccia i tag annotati; `--end-of-options` protegge dai ref esotici.
    //
    // ⚠️ Ref AMBIGUO (un tag e un branch con lo stesso nome): qui vince il tag,
    // perché `<ref>` nudo segue la disambiguazione di git (refs/tags prima di
    // refs/remotes). È il default di git e va bene, ma nel caso patologico il
    // fetch shallow — che risolve il nome lato SERVER — e questo fallback
    // potrebbero pinnare commit diversi. Non lo compensiamo: il registro pinna
    // comunque lo sha risolto, quindi l'ambiguità si vede nel pin salvato.
    const resolved = await resolveRef(git, [ref, `origin/${ref}`]);
    if (resolved === null) {
      throw new PluginGitError(
        `Ref "${redact(ref)}" non trovato in ${redact(url)} dopo il fetch completo`,
      );
    }
    target = resolved;
  }

  const checkout = await git(["checkout", "-q", "--detach", target]);
  if (!checkout.ok) throw fail("Checkout", url, ref, checkout);

  const head = await git(["rev-parse", "HEAD"]);
  if (!head.ok) throw fail("Lettura dello sha", url, ref, head);

  // La dir del plugin è solo contenuto: `.git` (che tra l'altro contiene l'URL
  // remoto) non ha ragione di finire in `/plugins`.
  //
  // Questa rimozione sta FUORI dal budget di `timeoutMs`, deliberatamente:
  // `fs.rm` non ha un timeout e interromperla a metà lascerebbe un `.git`
  // parziale — cioè una dir di plugin sporca — che è peggio di uno sforamento.
  // Dopo un fetch completo l'oggetto può essere grosso: chi dimensiona il
  // timeout del job deve tenerne conto (è I/O locale, non rete).
  try {
    await rm(join(destDir, ".git"), { recursive: true, force: true });
  } catch (error) {
    throw new PluginGitError(`Rimozione di .git in ${destDir} fallita: ${describe(error)}`);
  }

  return { sha: head.stdout };
}

/** Primo dei candidati che git risolve in un commit, o `null`. */
async function resolveRef(git: GitRunner, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const result = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${candidate}^{commit}`,
    ]);
    if (result.ok && result.stdout.length > 0) return result.stdout;
  }
  return null;
}

/** Messaggio di un errore non-git (filesystem), redatto per sicurezza. */
function describe(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
