import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";
import { createDriveObjectReader, DriveObjectMissing, DriveObjectTooLarge, isDriveKey } from "./storage-read.js";

// Lo storage dal worker (area 5, fetta 3): SOLA LETTURA, solo `drive/`, con un
// tetto di byte. La sola lettura è una regola del codice: il sorgente del
// worker non importa nulla che scriva o cancelli.

const config = { endpoint: "https://s3.example", region: "auto", bucket: "b", accessKey: "a", secretKey: "s" };
const sink = () => new Writable({ write: (_c, _e, done) => done() });

describe("createDriveObjectReader", () => {
  it("solo chiavi del Drive: una della Chat, una che risale o assoluta non parte nemmeno", async () => {
    const send = vi.fn();
    const read = createDriveObjectReader(config, { send } as never).getObjectStream;
    for (const key of ["chat/c/1/a.pdf", "drive/../chat/x", "drive/p/./x", "/etc/passwd", "tickets/1/a"]) {
      await expect(read(key, { maxBytes: 10 })).rejects.toThrow("not a Drive key");
    }
    expect(send).not.toHaveBeenCalled();
    expect(isDriveKey("drive/p/f/a b.pdf")).toBe(true);
  });

  it("legge il corpo; oltre il tetto lo stream si ferma con un errore e la sorgente si chiude", async () => {
    const chunks = [Buffer.alloc(6), Buffer.alloc(6), Buffer.alloc(6)];
    const body = Readable.from(chunks);
    const send = vi.fn(async () => ({ Body: body }));
    const read = createDriveObjectReader(config, { send } as never).getObjectStream;
    await pipeline(await read("drive/p/f/a.pdf", { maxBytes: 18 }), sink());
    const big = Readable.from([Buffer.alloc(6), Buffer.alloc(6), Buffer.alloc(6)]);
    send.mockResolvedValueOnce({ Body: big });
    await expect(pipeline(await read("drive/p/f/b.pdf", { maxBytes: 10 }), sink())).rejects.toBeInstanceOf(DriveObjectTooLarge);
    expect(big.destroyed).toBe(true);
    expect((send.mock.calls[0] as unknown as [{ input: unknown }])[0].input).toEqual({ Bucket: "b", Key: "drive/p/f/a.pdf" });
  });

  it("un oggetto che non c'è più è DriveObjectMissing", async () => {
    const read = createDriveObjectReader(config, { send: async () => Promise.reject(Object.assign(new Error("x"), { name: "NoSuchKey" })) } as never).getObjectStream;
    await expect(read("drive/p/f/a.pdf", { maxBytes: 10 })).rejects.toBeInstanceOf(DriveObjectMissing);
  });
});

describe("il worker non scrive nello storage (sul sorgente)", () => {
  const SRC = join(import.meta.dirname, "..");
  async function sources(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await sources(p)));
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
    }
    return out;
  }

  it("niente Put, Delete, Copy, multipart né URL firmati; l'SDK S3 solo in storage-read.ts, con GetObjectCommand e S3Client", async () => {
    const files = await sources(SRC);
    expect(files.length).toBeGreaterThan(50);
    const WRITES = /PutObject|DeleteObject|CopyObject|CreateMultipartUpload|UploadPart|CompleteMultipartUpload|PutBucket|DeleteBucket|lib-storage|s3-request-presigner|getSignedUrl/;
    for (const f of files) {
      const text = await readFile(f, "utf8");
      expect(WRITES.test(text), f).toBe(false);
      if (/@aws-sdk\//.test(text)) {
        expect(f.endsWith(join("drive", "storage-read.ts")), f).toBe(true);
        const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@aws-sdk\/client-s3"/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()).filter(Boolean));
        expect(imports.sort()).toEqual(["GetObjectCommand", "S3Client"]);
        expect(text.match(/@aws-sdk\//g)).toHaveLength(1);
      }
    }
    const pkg = JSON.parse(await readFile(join(SRC, "..", "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).filter((d) => d.startsWith("@aws-sdk/"))).toEqual(["@aws-sdk/client-s3"]);
  });
});
