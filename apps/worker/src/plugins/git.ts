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
 * privato fallisce, non si autentica di nascosto.
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

interface GitResult {
  ok: boolean;
  stdout: string;
  /** stderr redatto e troncato (vuoto se il comando è andato a buon fine). */
  stderr: string;
  /** Descrizione del fallimento pronta per un messaggio d'errore. */
  reason: string;
}

/** Esegue git senza auth entro la scadenza condivisa; non lancia mai. */
async function runGit(args: string[], cwd: string, deadline: number): Promise<GitResult> {
  // Almeno 1ms: execa con timeout 0 non applicherebbe nessun limite.
  const timeout = Math.max(1, deadline - Date.now());
  try {
    const { stdout } = await execa(
      "git",
      // `credential.helper=` (valore vuoto) AZZERA la lista di helper ereditata
      // dalla config di sistema/utente: nemmeno un helper configurato
      // sull'host può fornire credenziali a questo fetch. `core.askPass=` fa
      // lo stesso con l'eventuale programma di prompt.
      ["-c", "credential.helper=", "-c", "core.askPass=", ...args],
      {
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
      },
    );
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
  await mkdir(destDir, { recursive: true });

  const init = await runGit(["init", "-q", "-b", "main"], destDir, deadline);
  if (!init.ok) throw fail("Init", url, ref, init);

  const shallow = await runGit(["fetch", "--depth", "1", "--no-tags", url, ref], destDir, deadline);

  let target = "FETCH_HEAD";
  if (!shallow.ok) {
    // Fallback: scarica tutti i branch e i tag, poi risolvi il ref localmente.
    const full = await runGit(
      ["fetch", url, "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"],
      destDir,
      deadline,
    );
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
    const resolved = await resolveRef(destDir, deadline, [ref, `origin/${ref}`]);
    if (resolved === null) {
      throw new PluginGitError(
        `Ref "${redact(ref)}" non trovato in ${redact(url)} dopo il fetch completo`,
      );
    }
    target = resolved;
  }

  const checkout = await runGit(["checkout", "-q", "--detach", target], destDir, deadline);
  if (!checkout.ok) throw fail("Checkout", url, ref, checkout);

  const head = await runGit(["rev-parse", "HEAD"], destDir, deadline);
  if (!head.ok) throw fail("Lettura dello sha", url, ref, head);

  // La dir del plugin è solo contenuto: `.git` (che tra l'altro contiene l'URL
  // remoto) non ha ragione di finire in `/plugins`.
  await rm(join(destDir, ".git"), { recursive: true, force: true });

  return { sha: head.stdout };
}

/** Primo dei candidati che git risolve in un commit, o `null`. */
async function resolveRef(
  cwd: string,
  deadline: number,
  candidates: string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    const result = await runGit(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{commit}`],
      cwd,
      deadline,
    );
    if (result.ok && result.stdout.length > 0) return result.stdout;
  }
  return null;
}
