import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt } from "@stubwise/db";

// Mock dell'SDK AWS: nessuna chiamata di rete reale. I command sono classi
// fittizie che salvano gli argomenti; `send` e `getSignedUrl` sono spy.
const sendMock = vi.fn();
const s3ClientMock = vi.fn();

class PutObjectCommand {
  constructor(public input: unknown) {}
}
class GetObjectCommand {
  constructor(public input: unknown) {}
}
class DeleteObjectCommand {
  constructor(public input: unknown) {}
}
class CopyObjectCommand {
  constructor(public input: unknown) {}
}

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = sendMock;
    constructor(config: unknown) {
      s3ClientMock(config);
    }
  },
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
}));

// Il caricamento multipart (area 5, fetta 2): `Upload` fittizio che consuma lo stream.
const uploadMock = vi.fn();
const uploadAbort = vi.fn();
vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    constructor(public options: { params: { Body: AsyncIterable<Buffer> } }) {
      uploadMock(options);
    }
    async done() {
      let size = 0;
      for await (const chunk of this.options.params.Body) size += chunk.length;
      return { size };
    }
    async abort() {
      uploadAbort();
    }
  },
}));

const getSignedUrlMock = vi.fn();
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

// Import dopo i mock.
const { createS3Storage, s3ConfigFromSettings } = await import("./index.js");
const { contentDisposition } = await import("./s3.js");

const config = {
  endpoint: "https://s3.example.com",
  region: "auto",
  bucket: "my-bucket",
  accessKey: "AKIA",
  secretKey: "secret",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("s3ConfigFromSettings", () => {
  const key = randomBytes(32);

  it("ritorna la config con secretKey decifrata quando i settings sono completi", () => {
    const settings = {
      s3Endpoint: "https://s3.example.com",
      s3Region: "eu-central",
      s3Bucket: "my-bucket",
      s3AccessKey: "AKIA",
      s3SecretKeyEncrypted: encrypt("super-secret", key),
    };
    const result = s3ConfigFromSettings(settings, key);
    expect(result).toEqual({
      endpoint: "https://s3.example.com",
      region: "eu-central",
      bucket: "my-bucket",
      accessKey: "AKIA",
      secretKey: "super-secret",
    });
  });

  it("usa region di default 'auto' quando manca ma il resto è presente", () => {
    const settings = {
      s3Endpoint: "https://s3.example.com",
      s3Region: null,
      s3Bucket: "my-bucket",
      s3AccessKey: "AKIA",
      s3SecretKeyEncrypted: encrypt("super-secret", key),
    };
    const result = s3ConfigFromSettings(settings, key);
    expect(result?.region).toBe("auto");
  });

  it("ritorna null se manca il bucket", () => {
    const settings = {
      s3Endpoint: "https://s3.example.com",
      s3Region: "auto",
      s3Bucket: null,
      s3AccessKey: "AKIA",
      s3SecretKeyEncrypted: encrypt("super-secret", key),
    };
    expect(s3ConfigFromSettings(settings, key)).toBeNull();
  });

  it("ritorna null se manca l'accessKey", () => {
    const settings = {
      s3Endpoint: "https://s3.example.com",
      s3Region: "auto",
      s3Bucket: "my-bucket",
      s3AccessKey: null,
      s3SecretKeyEncrypted: encrypt("super-secret", key),
    };
    expect(s3ConfigFromSettings(settings, key)).toBeNull();
  });

  it("ritorna null se manca il secret cifrato", () => {
    const settings = {
      s3Endpoint: "https://s3.example.com",
      s3Region: "auto",
      s3Bucket: "my-bucket",
      s3AccessKey: "AKIA",
      s3SecretKeyEncrypted: null,
    };
    expect(s3ConfigFromSettings(settings, key)).toBeNull();
  });

  it("ritorna null se manca l'endpoint", () => {
    const settings = {
      s3Endpoint: null,
      s3Region: "auto",
      s3Bucket: "my-bucket",
      s3AccessKey: "AKIA",
      s3SecretKeyEncrypted: encrypt("super-secret", key),
    };
    expect(s3ConfigFromSettings(settings, key)).toBeNull();
  });
});

describe("createS3Storage", () => {
  it("istanzia S3Client con forcePathStyle e credenziali", () => {
    createS3Storage(config);
    expect(s3ClientMock).toHaveBeenCalledWith({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      forcePathStyle: true,
    });
  });

  it("putObject costruisce PutObjectCommand e chiama send", async () => {
    const storage = createS3Storage(config);
    const body = Buffer.from("hello");
    await storage.putObject("key/abc", body, "image/png");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: config.bucket,
      Key: "key/abc",
      Body: body,
      ContentType: "image/png",
    });
  });

  it("deleteObject costruisce DeleteObjectCommand e chiama send", async () => {
    const storage = createS3Storage(config);
    await storage.deleteObject("key/abc");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]?.[0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({ Bucket: config.bucket, Key: "key/abc" });
  });

  it("getSignedDownloadUrl chiama getSignedUrl con GetObjectCommand e ritorna l'URL", async () => {
    getSignedUrlMock.mockResolvedValue("https://signed.example/url");
    const storage = createS3Storage(config);
    const url = await storage.getSignedDownloadUrl("key/abc", "report.pdf", 600);
    expect(url).toBe("https://signed.example/url");
    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
    const [, command, options] = getSignedUrlMock.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input).toEqual({
      Bucket: config.bucket,
      Key: "key/abc",
      ResponseContentDisposition: 'attachment; filename="report.pdf"',
    });
    expect(options).toEqual({ expiresIn: 600 });
  });

  it("getSignedDownloadUrl usa expiresIn di default 300", async () => {
    getSignedUrlMock.mockResolvedValue("https://signed.example/url");
    const storage = createS3Storage(config);
    await storage.getSignedDownloadUrl("key/abc", "report.pdf");
    const [, , options] = getSignedUrlMock.mock.calls[0] ?? [];
    expect(options).toEqual({ expiresIn: 300 });
  });

  it("getSignedDownloadUrl sanifica virgolette e CR/LF nel filename", async () => {
    getSignedUrlMock.mockResolvedValue("https://signed.example/url");
    const storage = createS3Storage(config);
    await storage.getSignedDownloadUrl("key/abc", 'ev"il\r\nname.pdf');
    const [, command] = getSignedUrlMock.mock.calls[0] ?? [];
    const disposition = (command as GetObjectCommand).input as {
      ResponseContentDisposition: string;
    };
    expect(disposition.ResponseContentDisposition).not.toContain('"il');
    expect(disposition.ResponseContentDisposition).not.toMatch(/[\r\n]/);
    expect(disposition.ResponseContentDisposition).toContain("evilname.pdf");
  });
});

describe("contentDisposition (review della fetta 4): ticket e Chat scaricano con la stessa regola", () => {
  it("toglie tutti i caratteri di controllo, virgolette e backslash", () => {
    expect(contentDisposition("re\tpo\u0000rt\u007f\"x\\.pdf")).toBe('attachment; filename="reportx.pdf"');
  });
  it("un nome non ASCII ha il ripiego ASCII e filename* in UTF-8", () => {
    expect(contentDisposition("Fattura già (ottobre).pdf")).toBe(
      "attachment; filename=\"Fattura gi_ (ottobre).pdf\"; filename*=UTF-8''Fattura%20gi%C3%A0%20%28ottobre%29.pdf",
    );
  });
  it("getSignedDownloadUrl la usa, per una chiave di ticket e per una della Chat", async () => {
    getSignedUrlMock.mockResolvedValue("https://signed.example/url");
    const storage = createS3Storage(config);
    for (const key of ["tickets/t/1/a.pdf", "chat/c/1/a.pdf"]) {
      await storage.getSignedDownloadUrl(key, "Città.pdf");
    }
    const dispositions = getSignedUrlMock.mock.calls.map((c) => ((c[1] as GetObjectCommand).input as { ResponseContentDisposition: string }).ResponseContentDisposition);
    expect(dispositions).toEqual([contentDisposition("Città.pdf"), contentDisposition("Città.pdf")]);
    expect(dispositions[0]).toContain("filename*=UTF-8''Citt%C3%A0.pdf");
  });
});

describe("lo storage del Drive (area 5, fetta 2)", () => {
  it("putObjectStream carica uno stream col multipart, senza bufferizzarlo", async () => {
    const { Readable } = await import("node:stream");
    const storage = createS3Storage(config);
    await storage.putObjectStream("drive/p/1/a.pdf", Readable.from([Buffer.alloc(5), Buffer.alloc(7)]), "application/pdf");
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const { params } = uploadMock.mock.calls[0]![0] as { params: { Bucket: string; Key: string; ContentType: string; Body: unknown } };
    expect(params).toMatchObject({ Bucket: config.bucket, Key: "drive/p/1/a.pdf", ContentType: "application/pdf" });
    expect(Buffer.isBuffer(params.Body)).toBe(false);
  });

  it("copyObject copia una chiave in un'altra (Save to Drive: due oggetti indipendenti)", async () => {
    const storage = createS3Storage(config);
    await storage.copyObject("chat/c/1/a b.pdf", "drive/p/2/a b.pdf");
    const command = sendMock.mock.calls[0]?.[0] as CopyObjectCommand;
    expect(command).toBeInstanceOf(CopyObjectCommand);
    expect(command.input).toEqual({ Bucket: config.bucket, Key: "drive/p/2/a b.pdf", CopySource: `${config.bucket}/chat/c/1/a%20b.pdf` });
  });

  it("l'anteprima inline ha un Content-Type esplicito; senza, sempre attachment", async () => {
    getSignedUrlMock.mockResolvedValue("https://signed.example/url");
    const storage = createS3Storage(config);
    await storage.getSignedDownloadUrl("drive/p/1/n.txt", "nota.txt", 300, { inlineContentType: "text/plain; charset=utf-8" });
    const input = (getSignedUrlMock.mock.calls[0]![1] as GetObjectCommand).input as Record<string, string>;
    expect(input.ResponseContentDisposition).toBe('inline; filename="nota.txt"');
    expect(input.ResponseContentType).toBe("text/plain; charset=utf-8");
    await storage.getSignedDownloadUrl("drive/p/1/n.txt", "nota.txt");
    const plain = (getSignedUrlMock.mock.calls[1]![1] as GetObjectCommand).input as Record<string, string>;
    expect(plain.ResponseContentDisposition).toBe('attachment; filename="nota.txt"');
    expect(plain.ResponseContentType).toBeUndefined();
  });

  it("lo storage dice la sua origine (per non servire inline dallo stesso host dell'istanza)", () => {
    expect(createS3Storage(config).origin).toBe("https://s3.example.com");
  });
});

