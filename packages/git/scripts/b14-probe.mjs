// Script MANUALE della verifica B14 del ciclo di correzione post-PR: non fa
// parte del build (tsconfig include solo src/) né dei test. Guida completa:
// docs/plans/2026-09-30-pr-correction-loop-b14.md.
// Lancio, dal worktree, dopo aver esportato le variabili della guida:
//   pnpm --filter @stubwise/git... build
//   node packages/git/scripts/b14-probe.mjs <comando> ...
//
// B14 — sonda per i casi "lanciare <metodo> da uno script".
// Chiama i metodi VERI di @stubwise/git (dist buildato) e stampa SOLO:
// esito, status HTTP dell'errore, messaggio REDATTO e alcuni controlli.
// Non stampa mai il token: se il messaggio lo contenesse, lo sostituisce con
// [TOKEN]/[BASE64] prima di stamparlo e lo segnala con "CONTIENE ...: SI".
// Non stampa mai error.responseText.
//
// Uso (le credenziali si passano per NOME di variabile d'ambiente):
//   node b14-probe.mjs bb-user   <EMAIL_VAR> <TOKEN_VAR>
//   node b14-probe.mjs gh-user   <TOKEN_VAR>
//   node b14-probe.mjs bb-status <EMAIL_VAR> <TOKEN_VAR>          (WS, REPO, BB_SHA, BB_BRANCH)
//   node b14-probe.mjs gh-status <TOKEN_VAR> [emoji]              (O, R, GH_SHA)
//   node b14-probe.mjs bb-review <EMAIL_VAR> <TOKEN_VAR> <PR> <approve|request_changes>   (WS, REPO)
//   node b14-probe.mjs gh-review <TOKEN_VAR> <PR> <approve|request_changes>               (O, R)
import { pathToFileURL } from "node:url";

// Il dist del package accanto allo script (packages/git/dist): va buildato
// prima con `pnpm --filter @stubwise/git... build`. STUBWISE_GIT_DIST lo
// sostituisce con un altro percorso.
const distUrl = process.env.STUBWISE_GIT_DIST
  ? pathToFileURL(process.env.STUBWISE_GIT_DIST).href
  : new URL("../dist/index.js", import.meta.url).href;
const git = await import(distUrl);
const { BitbucketProvider, GitHubProvider, PR_REVIEW_PERMISSION_HINT, COMMIT_STATUS_PERMISSION_HINT } = git;

function env(name) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`Variabile d'ambiente mancante: ${name}`);
    process.exit(2);
  }
  return v;
}

const [cmd, ...args] = process.argv.slice(2);
const secrets = []; // stringhe da non far mai uscire
let bbEmail;

function trackBitbucket(emailVar, tokenVar) {
  bbEmail = env(emailVar);
  const token = env(tokenVar);
  secrets.push(
    ["TOKEN", token],
    ["BASE64(email:token)", Buffer.from(`${bbEmail}:${token}`).toString("base64")],
    ["BASE64(token)", Buffer.from(token).toString("base64")]
  );
  return { email: bbEmail, token };
}
function trackGitHub(tokenVar) {
  const token = env(tokenVar);
  secrets.push(["TOKEN", token], ["BASE64(token)", Buffer.from(token).toString("base64")]);
  return { token };
}

const REVIEW_BODY = "Prova B14 (verifica manuale del verdetto): nessuna azione richiesta.";

async function run() {
  switch (cmd) {
    case "bb-user": {
      const credentials = trackBitbucket(args[0], args[1]);
      return new BitbucketProvider().getAuthenticatedUserId({ credentials });
    }
    case "gh-user": {
      const credentials = trackGitHub(args[0]);
      return new GitHubProvider().getAuthenticatedUserId({ credentials });
    }
    case "bb-status": {
      const credentials = trackBitbucket(args[0], args[1]);
      const p = { repoUrl: `https://bitbucket.org/${env("WS")}/${env("REPO")}`, defaultBranch: "main", credentials };
      return new BitbucketProvider().setCommitStatus(p, env("BB_SHA"), {
        state: "pending",
        key: "stubwise-review",
        description: "Prova B14: token senza scrittura",
        refname: env("BB_BRANCH"),
      });
    }
    case "gh-status": {
      const credentials = trackGitHub(args[0]);
      const p = { repoUrl: `https://github.com/${env("O")}/${env("R")}`, defaultBranch: "main", credentials };
      const description =
        args[1] === "emoji" ? `${"x".repeat(138)}\u{1F600}y` : "Prova B14: token senza permesso";
      if (args[1] === "emoji") console.log(`descrizione passata: .length = ${description.length}`);
      return new GitHubProvider().setCommitStatus(p, env("GH_SHA"), {
        state: "pending",
        key: "stubwise-review",
        description,
      });
    }
    case "bb-review": {
      const credentials = trackBitbucket(args[0], args[1]);
      const p = { repoUrl: `https://bitbucket.org/${env("WS")}/${env("REPO")}`, defaultBranch: "main", credentials };
      return new BitbucketProvider().submitPrReview(p, Number(args[2]), args[3], REVIEW_BODY);
    }
    case "gh-review": {
      const credentials = trackGitHub(args[0]);
      const p = { repoUrl: `https://github.com/${env("O")}/${env("R")}`, defaultBranch: "main", credentials };
      return new GitHubProvider().submitPrReview(p, Number(args[1]), args[2], REVIEW_BODY);
    }
    default:
      console.error("Comando sconosciuto. Vedi l'intestazione del file.");
      process.exit(2);
  }
}

try {
  const result = await run();
  console.log(`ESITO: OK${result !== undefined ? ` -> ${JSON.stringify(result)}` : ""}`);
} catch (error) {
  let message = error instanceof Error ? error.message : String(error);
  const found = [];
  for (const [label, value] of secrets) {
    if (value && message.includes(value)) {
      found.push(label);
      message = message.split(value).join(`[${label}]`);
    }
  }
  console.log("ESITO: ERRORE");
  console.log(`tipo: ${error?.constructor?.name ?? typeof error}`);
  if (typeof error?.status === "number") console.log(`status HTTP: ${error.status}`);
  console.log(`messaggio (redatto): ${message}`);
  console.log(`CONTIENE IL TOKEN O LA SUA FORMA BASE64: ${found.length > 0 ? `SI (${found.join(", ")})` : "no"}`);
  console.log(`contiene il suggerimento sui permessi della review: ${message.includes(PR_REVIEW_PERMISSION_HINT) ? "SI" : "no"}`);
  console.log(`contiene il suggerimento sui permessi dello status: ${message.includes(COMMIT_STATUS_PERMISSION_HINT) ? "SI" : "no"}`);
}
