#!/usr/bin/env node
/**
 * Esempio: inserire in blocco credenziali nella cassaforte di un progetto da
 * un CSV, via API e con un token personale (PAT). La password si cifra QUI,
 * sulla macchina di chi lancia lo script, con `@stubwise/vault-crypto`: al
 * server arrivano solo la busta cifrata e le copie della chiave, mai la
 * password in chiaro (design `docs/plans/2026-10-23-cassaforte-credenziali-design.md`).
 *
 * Uso, dalla radice del monorepo (dopo `pnpm --filter @stubwise/vault-crypto build`):
 *
 *   STUBWISE_URL=https://stubwise.example.com STUBWISE_TOKEN=stw_pat_… \
 *     node packages/vault-crypto/scripts/vault-insert-example.mjs <projectId> <file.csv>
 *
 * Il CSV ha una riga d'intestazione coi nomi delle colonne, in qualunque
 * ordine: `service` e `password` obbligatorie, `label`, `url`, `username`,
 * `notes` facoltative; nessun'altra. Separatore virgola, codifica UTF-8;
 * un campo con virgole, virgolette o a capo va fra virgolette doppie, e una
 * virgoletta dentro un campo si raddoppia (`""`).
 *
 * Lo script NON stampa mai un valore del CSV — né password né servizi né
 * utenti — e nemmeno i corpi delle risposte di errore: solo conteggi, numeri
 * di riga e codici d'errore. Chi lo lancia da un assistente AI (Claude Code)
 * non gli faccia leggere il CSV: basta il percorso.
 *
 * Flusso: `GET /api/projects/:projectId/credentials/recipients` (una volta),
 * poi per ogni riga `encryptForInsert` per le persone con chiave confermata
 * più la chiave di recupero, e `POST /api/projects/:projectId/credentials`
 * ripetendo `recoveryPublicKey`. Se nel frattempo i destinatari sono cambiati
 * il server risponde 409 `recipients_changed` coi destinatari attuali e non
 * scrive nulla: lo script ricifra e riprova UNA volta, e tiene i destinatari
 * nuovi per le righe successive.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { encryptForInsert } from "@stubwise/vault-crypto";

export const COLUMNS = ["service", "label", "url", "username", "password", "notes"];
const REQUIRED = ["service", "password"];

/**
 * Un CSV in righe di campi (RFC 4180 essenziale: virgolette doppie, `""`
 * come virgoletta, virgole e a capo dentro un campo quotato, CRLF o LF). Le
 * righe interamente vuote si saltano. Un errore dice la riga, mai il contenuto.
 */
export function parseCsv(text) {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowStartLine = 1;

  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    field = "";
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      endRow();
      line += 1;
      rowStartLine = line;
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error(`CSV non valido: virgolette non chiuse (riga ${rowStartLine})`);
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Le righe del CSV come record, con il numero di riga del file (l'intestazione
 * è la riga 1). I campi facoltativi vuoti diventano `null`.
 */
export function readRecords(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error("CSV vuoto");
  const names = header.map((name) => name.trim().toLowerCase());
  const unknown = names.filter((name) => !COLUMNS.includes(name));
  if (unknown.length > 0) {
    throw new Error(`Colonne sconosciute: ${unknown.join(", ")} (ammesse: ${COLUMNS.join(", ")})`);
  }
  for (const name of REQUIRED) {
    if (!names.includes(name)) throw new Error(`Manca la colonna obbligatoria «${name}»`);
  }
  return rows.map((fields, index) => {
    const value = (name) => {
      const at = names.indexOf(name);
      const raw = at === -1 ? "" : (fields[at] ?? "");
      return name === "password" ? raw : raw.trim();
    };
    const optional = (name) => value(name) || null;
    return {
      row: index + 2,
      service: value("service"),
      password: value("password"),
      label: optional("label"),
      url: optional("url"),
      username: optional("username"),
      notes: optional("notes"),
    };
  });
}

/** Il codice d'errore di una risposta (mai il messaggio, che potrebbe citare valori). */
async function errorCode(response) {
  try {
    const body = await response.json();
    return typeof body?.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

function toCopiesRecipients(recipients) {
  return [
    ...recipients.people.map((person) => ({ recipientId: person.personKeyId, publicKey: person.publicKey })),
    { recipientId: "recovery", publicKey: recipients.recoveryPublicKey },
  ];
}

/**
 * Cifra e inserisce i record. Restituisce quante credenziali sono state create
 * e le righe fallite (numero di riga e motivo: un codice, mai un valore).
 * `fetchImpl` e `log` sono iniettabili per i test.
 */
export async function insertCredentials({ baseUrl, token, projectId, records, fetchImpl = fetch, log = console.log }) {
  const root = baseUrl.replace(/\/+$/, "");
  const base = `${root}/api/projects/${encodeURIComponent(projectId)}/credentials`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };

  const recipientsResponse = await fetchImpl(`${base}/recipients`, { method: "GET", headers });
  if (!recipientsResponse.ok) {
    const code = await errorCode(recipientsResponse);
    throw new Error(`Destinatari non leggibili: ${recipientsResponse.status}${code ? ` ${code}` : ""}`);
  }
  let recipients = await recipientsResponse.json();

  const post = async (record, id) => {
    const { passwordCiphertext, copies } = await encryptForInsert({
      credentialId: id,
      password: record.password,
      recipients: toCopiesRecipients(recipients),
    });
    return fetchImpl(base, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        id,
        service: record.service,
        label: record.label,
        url: record.url,
        username: record.username,
        notes: record.notes,
        passwordCiphertext,
        copies,
        recoveryPublicKey: recipients.recoveryPublicKey,
      }),
    });
  };

  let created = 0;
  const failed = [];
  for (const record of records) {
    if (!record.service) {
      failed.push({ row: record.row, reason: "service mancante" });
      continue;
    }
    if (!record.password) {
      failed.push({ row: record.row, reason: "password mancante" });
      continue;
    }
    const id = crypto.randomUUID();
    let response = await post(record, id);
    if (response.status === 409) {
      const body = await response.json().catch(() => null);
      if (body?.code === "recipients_changed" && body.recipients) {
        // I destinatari sono cambiati (un admin aggiunto, una chiave
        // confermata, il kit rigenerato): ricifra per quelli attuali e
        // riprova una volta. Nulla era stato scritto.
        recipients = body.recipients;
        response = await post(record, id);
      } else {
        failed.push({ row: record.row, reason: `409${body?.code ? ` ${body.code}` : ""}` });
        continue;
      }
    }
    if (response.ok) {
      created += 1;
      continue;
    }
    const code = await errorCode(response);
    failed.push({ row: record.row, reason: `${response.status}${code ? ` ${code}` : ""}` });
  }

  log(`${created} create, ${failed.length} non inserite su ${records.length} righe`);
  for (const failure of failed) log(`riga ${failure.row}: ${failure.reason}`);
  return { created, failed };
}

async function main(argv) {
  const [projectId, file] = argv;
  const baseUrl = process.env.STUBWISE_URL;
  const token = process.env.STUBWISE_TOKEN;
  if (!projectId || !file || !baseUrl || !token) {
    console.error(
      "Uso: STUBWISE_URL=… STUBWISE_TOKEN=stw_pat_… node packages/vault-crypto/scripts/vault-insert-example.mjs <projectId> <file.csv>",
    );
    return 2;
  }
  const records = readRecords(await readFile(file, "utf8"));
  const { failed } = await insertCredentials({ baseUrl, token, projectId, records });
  return failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      // Solo il messaggio: gli errori di questo script non citano valori del CSV.
      console.error(error instanceof Error ? error.message : "Errore");
      process.exit(1);
    },
  );
}
