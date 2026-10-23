import { describe, expect, it } from "vitest";

import { decryptPassword, generatePersonKeyPair, generateRecoveryKit, parseRecoveryKit, unwrapItemKey } from "../src/index.js";
import { insertCredentials, parseCsv, readRecords } from "./vault-insert-example.mjs";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SECRETS = ["pw-uno-SEGRETA", 'pw,"due"-SEGRETA', "pw-tre\nSEGRETA"];

const CSV = [
  "service,label,url,username,password,notes",
  `GitHub,bot,https://github.com,bot@example.com,${SECRETS[0]},`,
  `"Fornitore, Srl",,,,"${SECRETS[1].replace(/"/g, '""')}","nota con ""virgolette"""`,
  `Server,,,root,"${SECRETS[2]}",`,
].join("\n");

type Recipients = {
  people: Array<{ userId: string; email: string; personKeyId: string; publicKey: string }>;
  recoveryPublicKey: string;
};

async function makeRecipients(n: number) {
  const people = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const pair = await generatePersonKeyPair();
      return {
        view: {
          userId: crypto.randomUUID(),
          email: `p${i}@example.com`,
          personKeyId: crypto.randomUUID(),
          publicKey: pair.publicKey,
        },
        privateKey: pair.privateKey,
      };
    }),
  );
  const kit = await generateRecoveryKit();
  const recipients: Recipients = {
    people: people.map((p) => p.view),
    recoveryPublicKey: kit.publicKey,
  };
  return { recipients, people, kitText: kit.kitText };
}

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** Un server finto: GET dei destinatari e POST di creazione, con una risposta per POST programmabile. */
function fakeServer(options: {
  recipients: () => Recipients;
  postResponses?: Array<(body: Record<string, unknown>) => { status: number; body: unknown } | null>;
}) {
  const calls: Call[] = [];
  let posts = 0;
  const fetchImpl = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, headers: init.headers ?? {}, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.endsWith(`/api/projects/${PROJECT_ID}/credentials/recipients`)) {
      return json(200, options.recipients());
    }
    if (method === "POST" && url.endsWith(`/api/projects/${PROJECT_ID}/credentials`)) {
      const programmed = options.postResponses?.[posts]?.(body);
      posts += 1;
      if (programmed) return json(programmed.status, programmed.body);
      return json(201, { id: body.id, service: body.service });
    }
    return json(404, { code: "not_found", message: "Not found" });
  };
  return { fetchImpl, calls };
}

function collector() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

describe("parseCsv", () => {
  it("gestisce virgolette, virgole e a capo dentro un campo e virgolette raddoppiate", () => {
    expect(parseCsv('a,b\n"x, y","riga1\nriga2"\r\n"di ""lui""",\n')).toEqual([
      ["a", "b"],
      ["x, y", "riga1\nriga2"],
      ['di "lui"', ""],
    ]);
  });

  it("toglie il BOM e salta le righe vuote", () => {
    expect(parseCsv("﻿service,password\n\nA,b\n")).toEqual([
      ["service", "password"],
      ["A", "b"],
    ]);
  });

  it("una virgoletta non chiusa è un errore che non riporta il contenuto", () => {
    expect(() => parseCsv('service,password\nA,"segreto-non-chiuso')).toThrow(/riga 2/);
    try {
      parseCsv('service,password\nA,"segreto-non-chiuso');
    } catch (error) {
      expect(String(error)).not.toContain("segreto");
    }
  });
});

describe("readRecords", () => {
  it("legge le colonne dall'intestazione, in qualunque ordine, e numera le righe del file", () => {
    const records = readRecords("password,service\nx,A\ny,B\n");
    expect(records).toEqual([
      { row: 2, service: "A", password: "x", label: null, url: null, username: null, notes: null },
      { row: 3, service: "B", password: "y", label: null, url: null, username: null, notes: null },
    ]);
  });

  it("rifiuta un'intestazione senza service o password, o con colonne sconosciute (per posizione)", () => {
    expect(() => readRecords("service\nA\n")).toThrow(/password/);
    expect(() => readRecords("service,password,pin\nA,b,1\n")).toThrow(/colonna 3 sconosciuta/);
  });

  it("un CSV SENZA intestazione: l'errore non riporta nessun valore della prima riga", () => {
    const values = ["GitHub", "bot", "https://github.com", "bot@example.com", SECRETS[0], "nota"];
    let message = "";
    try {
      readRecords(`${values.join(",")}\nAltro,,,,x,\n`);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/colonne 1, 2, 3, 4, 5, 6 sconosciute/);
    for (const value of values) expect(message).not.toContain(value);
  });
});

describe("insertCredentials", () => {
  it("3 righe → 3 POST cifrati per tutti i destinatari, nessun valore su stdout/stderr", async () => {
    const { recipients, people, kitText } = await makeRecipients(2);
    const server = fakeServer({ recipients: () => recipients });
    const out = collector();

    const result = await insertCredentials({
      baseUrl: "https://stubwise.test/",
      token: "stw_pat_segreto",
      projectId: PROJECT_ID,
      records: readRecords(CSV),
      fetchImpl: server.fetchImpl,
      log: out.log,
    });

    expect(result).toEqual({ created: 3, failed: [] });
    const posts = server.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(3);
    expect(server.calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(server.calls.every((c) => c.headers.authorization === "Bearer stw_pat_segreto")).toBe(true);

    const ids = new Set<string>();
    for (const [i, post] of posts.entries()) {
      const body = post.body as {
        id: string;
        service: string;
        passwordCiphertext: string;
        copies: Array<{ recipientId: string; wrappedKey: string }>;
        recoveryPublicKey: string;
      };
      ids.add(body.id);
      expect(JSON.stringify(body)).not.toContain(SECRETS[i]);
      expect(body).not.toHaveProperty("password");
      expect(body.recoveryPublicKey).toBe(recipients.recoveryPublicKey);
      expect(body.copies.map((c) => c.recipientId).sort()).toEqual(
        [...recipients.people.map((p) => p.personKeyId), "recovery"].sort(),
      );
      // Ogni destinatario, e il kit, riaprono la password originale.
      for (const person of people) {
        const copy = body.copies.find((c) => c.recipientId === person.view.personKeyId)!;
        const itemKey = await unwrapItemKey(copy.wrappedKey, person.privateKey, body.id, copy.recipientId);
        expect(await decryptPassword(body.id, body.passwordCiphertext, itemKey)).toBe(SECRETS[i]);
      }
      const recovery = body.copies.find((c) => c.recipientId === "recovery")!;
      const recoveryKey = await unwrapItemKey(recovery.wrappedKey, await parseRecoveryKit(kitText), body.id, "recovery");
      expect(await decryptPassword(body.id, body.passwordCiphertext, recoveryKey)).toBe(SECRETS[i]);
    }
    expect(ids.size).toBe(3);
    expect((posts[1].body as { service: string; notes: string }).notes).toBe('nota con "virgolette"');

    const output = out.lines.join("\n");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
    for (const value of ["GitHub", "Fornitore", "bot@example.com", "github.com", "stw_pat_segreto"]) {
      expect(output).not.toContain(value);
    }
    expect(output).toMatch(/3 create/);
  });

  it("409 recipients_changed → ricifra per i destinatari del 409 e riprova una volta", async () => {
    const before = await makeRecipients(1);
    const after = await makeRecipients(2);
    const server = fakeServer({
      recipients: () => before.recipients,
      postResponses: [
        () => ({
          status: 409,
          body: { code: "recipients_changed", message: "changed", recipients: after.recipients },
        }),
      ],
    });
    const out = collector();

    const result = await insertCredentials({
      baseUrl: "https://stubwise.test",
      token: "stw_pat_x",
      projectId: PROJECT_ID,
      records: readRecords(CSV).slice(0, 2),
      fetchImpl: server.fetchImpl,
      log: out.log,
    });

    expect(result).toEqual({ created: 2, failed: [] });
    const posts = server.calls.filter((c) => c.method === "POST").map((c) => c.body as Record<string, unknown>);
    expect(posts).toHaveLength(3);
    const [first, retry, next] = posts as Array<{
      id: string;
      copies: Array<{ recipientId: string }>;
      recoveryPublicKey: string;
      passwordCiphertext: string;
    }>;
    expect(retry.id).toBe(first.id);
    expect(retry.passwordCiphertext).not.toBe(first.passwordCiphertext);
    expect(retry.recoveryPublicKey).toBe(after.recipients.recoveryPublicKey);
    expect(retry.copies.map((c) => c.recipientId).sort()).toEqual(
      [...after.recipients.people.map((p) => p.personKeyId), "recovery"].sort(),
    );
    // La riga dopo usa già i destinatari nuovi, senza un altro 409.
    expect(next.recoveryPublicKey).toBe(after.recipients.recoveryPublicKey);
    expect(next.copies).toHaveLength(3);
    for (const secret of SECRETS) expect(out.lines.join("\n")).not.toContain(secret);
  });

  it("un secondo 409 di fila sulla stessa riga la dà per fallita, senza un terzo tentativo", async () => {
    const { recipients } = await makeRecipients(1);
    const changed = () => ({
      status: 409,
      body: { code: "recipients_changed", message: "changed", recipients },
    });
    const server = fakeServer({ recipients: () => recipients, postResponses: [changed, changed] });
    const out = collector();

    const result = await insertCredentials({
      baseUrl: "https://stubwise.test",
      token: "stw_pat_x",
      projectId: PROJECT_ID,
      records: readRecords(CSV).slice(0, 1),
      fetchImpl: server.fetchImpl,
      log: out.log,
    });

    expect(result.created).toBe(0);
    expect(result.failed).toEqual([{ row: 2, reason: "409 recipients_changed" }]);
    expect(server.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(out.lines.join("\n")).toMatch(/riga 2/);
  });

  it("un errore su una riga non ferma le altre, e non stampa il corpo della risposta", async () => {
    const { recipients } = await makeRecipients(1);
    const server = fakeServer({
      recipients: () => recipients,
      postResponses: [() => ({ status: 400, body: { message: `body/service ${SECRETS[0]}` } })],
    });
    const out = collector();

    const result = await insertCredentials({
      baseUrl: "https://stubwise.test",
      token: "stw_pat_x",
      projectId: PROJECT_ID,
      records: readRecords(CSV),
      fetchImpl: server.fetchImpl,
      log: out.log,
    });

    expect(result).toEqual({ created: 2, failed: [{ row: 2, reason: "400" }] });
    for (const secret of SECRETS) expect(out.lines.join("\n")).not.toContain(secret);
  });

  it("una riga senza servizio o senza password è scartata senza chiamare il server", async () => {
    const { recipients } = await makeRecipients(1);
    const server = fakeServer({ recipients: () => recipients });
    const out = collector();

    const result = await insertCredentials({
      baseUrl: "https://stubwise.test",
      token: "stw_pat_x",
      projectId: PROJECT_ID,
      records: readRecords("service,password\n,abc\nA,\nB,c\n"),
      fetchImpl: server.fetchImpl,
      log: out.log,
    });

    expect(result).toEqual({
      created: 1,
      failed: [
        { row: 2, reason: "service mancante" },
        { row: 3, reason: "password mancante" },
      ],
    });
    expect(server.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("un codice d'errore non snake_case dal server non si stampa", async () => {
    const { recipients } = await makeRecipients(1);
    const server = fakeServer({
      recipients: () => recipients,
      postResponses: [
        () => ({ status: 400, body: { code: `x ${SECRETS[0]}` } }),
        () => ({ status: 409, body: { code: SECRETS[0] } }),
      ],
    });
    const out = collector();
    const result = await insertCredentials({
      baseUrl: "https://stubwise.test",
      token: "stw_pat_x",
      projectId: PROJECT_ID,
      records: readRecords(CSV).slice(0, 2),
      fetchImpl: server.fetchImpl,
      log: out.log,
    });
    expect(result.failed).toEqual([
      { row: 2, reason: "400 codice_non_stampabile" },
      { row: 3, reason: "409 codice_non_stampabile" },
    ]);
    expect(out.lines.join("\n")).not.toContain(SECRETS[0]);
  });

  it("destinatari non leggibili (permesso, cassaforte spenta) → errore col solo codice", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ code: "vault_not_active", message: "x" }), { status: 409 });
    await expect(
      insertCredentials({
        baseUrl: "https://stubwise.test",
        token: "stw_pat_x",
        projectId: PROJECT_ID,
        records: readRecords(CSV),
        fetchImpl,
        log: () => {},
      }),
    ).rejects.toThrow(/409 vault_not_active/);
  });
});
