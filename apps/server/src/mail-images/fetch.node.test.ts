import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeRequest, fetchRemoteImage, IMAGE_PROXY_USER_AGENT } from "./fetch.js";

// Il trasporto VERO del proxy (revisione I1): `https.request` col `lookup`
// fisso sull'indirizzo controllato, contro un server TLS locale. La CA e il
// certificato di `img.test` si generano qui con openssl (nessuna chiave nel
// repo); il DNS è finto e dà un indirizzo pubblico, e la connessione va
// davvero a 127.0.0.1 (`connectAddress`, solo per i test).

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let dir: string;
let server: Server;
let port: number;
let ca: Buffer;
const seen: { sni: string | undefined; host: string | undefined; headers: Record<string, unknown> }[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mail-images-tls-"));
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=test-ca");
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "img.key", "-out", "img.csr", "-subj", "/CN=img.test");
  writeFileSync(join(dir, "img.ext"), "subjectAltName=DNS:img.test\n");
  run("x509", "-req", "-in", "img.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "img.crt", "-days", "1", "-extfile", "img.ext");
  ca = readFileSync(join(dir, "ca.crt"));
  server = createServer({ key: readFileSync(join(dir, "img.key")), cert: readFileSync(join(dir, "img.crt")) }, (req, res) => {
    seen.push({ sni: (req.socket as unknown as { servername?: string }).servername, host: req.headers.host, headers: { ...req.headers } });
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as { port: number }).port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const deps = () => ({
  resolve: async () => ["93.184.216.34"],
  request: createNodeRequest({ port, ca, connectAddress: () => "127.0.0.1" }),
  totalMs: 8_000,
});

describe("il trasporto vero del proxy (https.request + lookup fisso)", () => {
  it("un nome host funziona: SNI e Host del nome, certificato verificato, solo i due header del proxy", async () => {
    seen.length = 0;
    const out = await fetchRemoteImage("https://img.test/logo.png", deps());
    expect(out).toEqual({ ok: true, contentType: "image/png", bytes: PNG });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sni).toBe("img.test");
    // Il nome, senza indirizzo IP; la porta c'è solo perché qui non è la 443.
    expect(seen[0]!.host).toBe(`img.test:${port}`);
    expect(seen[0]!.headers["user-agent"]).toBe(IMAGE_PROXY_USER_AGENT);
    expect(Object.keys(seen[0]!.headers).sort()).toEqual(["accept", "connection", "host", "user-agent"]);
  });

  it("il punto finale non arriva né in SNI né in Host (revisione M5)", async () => {
    seen.length = 0;
    expect((await fetchRemoteImage("https://img.test./logo.png", deps())).ok).toBe(true);
    expect([seen[0]!.sni, seen[0]!.host]).toEqual(["img.test", `img.test:${port}`]);
  });

  it("un nome che il certificato non copre: rifiutato (network), il TLS non si salta", async () => {
    seen.length = 0;
    expect(await fetchRemoteImage("https://other.test/logo.png", deps())).toEqual({ ok: false, reason: "network" });
    expect(seen).toEqual([]);
  });
});
