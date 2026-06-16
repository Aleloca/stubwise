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
}));

const getSignedUrlMock = vi.fn();
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

// Import dopo i mock.
const { createS3Storage, s3ConfigFromSettings } = await import("./index.js");

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
