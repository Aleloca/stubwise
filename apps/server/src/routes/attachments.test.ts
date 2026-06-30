import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { attachments } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import type { ObjectStorage } from "../storage/index.js";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

/**
 * Fake ObjectStorage in-memory: gli oggetti vivono in una Map, gli URL
 * presigned sono stringhe deterministiche. I metodi sono spy così i test
 * verificano chiavi e chiamate senza toccare la rete. È il punto di iniezione
 * usato dai task successivi: si passa a buildApp via `storageFactory`.
 */
function createFakeStorage(): ObjectStorage & {
  objects: Map<string, { body: Buffer; contentType: string }>;
  putObject: ReturnType<typeof vi.fn>;
  getSignedDownloadUrl: ReturnType<typeof vi.fn>;
  deleteObject: ReturnType<typeof vi.fn>;
} {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const putObject = vi.fn(async (key: string, body: Buffer, contentType: string) => {
    objects.set(key, { body, contentType });
  });
  const getSignedDownloadUrl = vi.fn(
    async (key: string, filename: string) =>
      `https://fake-storage.test/${key}?filename=${encodeURIComponent(filename)}`,
  );
  const deleteObject = vi.fn(async (key: string) => {
    objects.delete(key);
  });
  return { objects, putObject, getSignedDownloadUrl, deleteObject };
}

let testDb: TestDb;
let users: SeededUsers;
let projectId: string;
let repositoryId: string;

/** Storage corrente: lo cambiamo per-test (configurato vs assente). */
let activeStorage: ObjectStorage | null;
let fakeStorage: ReturnType<typeof createFakeStorage>;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
    // La factory legge la variabile activeStorage: i test la impostano.
    storageFactory: async () => activeStorage,
  });
  users = await seedUsers(app);
  projectId = await createProject();
}, 120_000);

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  fakeStorage = createFakeStorage();
  activeStorage = fakeStorage;
});

/** Crea un progetto (gruppo) con un repository sotto, salvando i due id. */
async function createProject(): Promise<string> {
  const seeded = await seedRepository(testDb.db);
  repositoryId = seeded.repositoryId;
  return seeded.projectId;
}

async function createTicket(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/tickets",
    headers: { cookie: users.memberCookie },
    payload: { projectId, repositoryId, title: "Ticket con allegati", type: "bug" },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function createComment(ticketId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/tickets/${ticketId}/comments`,
    headers: { cookie: users.memberCookie },
    payload: { body: "un commento" },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

const BOUNDARY = "----stubwisetestboundary";

/**
 * Costruisce un body multipart/form-data con un singolo file e campi opzionali.
 * Fastify `inject` accetta un Buffer come payload e l'header content-type col
 * boundary: @fastify/multipart lo parsa come una vera richiesta.
 */
function multipartBody(
  file: { filename: string; contentType: string; content: Buffer },
  fields: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    ),
    file.content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  );
  const payload = Buffer.concat(parts);
  return {
    payload,
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

function uploadAttachment(
  ticketId: string,
  cookie: string,
  file: { filename: string; contentType: string; content: Buffer },
  fields: Record<string, string> = {},
) {
  const { payload, headers } = multipartBody(file, fields);
  return app.inject({
    method: "POST",
    url: `/api/tickets/${ticketId}/attachments`,
    headers: { ...headers, cookie },
    payload,
  });
}

const pngFile = {
  filename: "screenshot.png",
  contentType: "image/png",
  content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

interface AttachmentBody {
  id: string;
  ticketId: string;
  commentId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

describe("POST /api/tickets/:ticketId/attachments", () => {
  it("storage configurato + MIME valido: 201, riga in attachments, putObject con la chiave attesa", async () => {
    const ticketId = await createTicket();
    const res = await uploadAttachment(ticketId, users.memberCookie, pngFile);
    expect(res.statusCode).toBe(201);
    const body = res.json() as AttachmentBody;
    expect(body).toMatchObject({
      ticketId,
      commentId: null,
      filename: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: pngFile.content.length,
    });

    const [row] = await testDb.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, body.id));
    expect(row).toBeDefined();
    expect(row?.uploaderId).toBe(users.memberId);

    expect(fakeStorage.putObject).toHaveBeenCalledTimes(1);
    const [key, buf, contentType] = fakeStorage.putObject.mock.calls[0]!;
    expect(key).toMatch(new RegExp(`^tickets/${ticketId}/[0-9a-f-]+/screenshot.png$`));
    expect(key).toBe(row?.storageKey);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(contentType).toBe("image/png");
  });

  it("associa un commento dello stesso ticket via campo commentId", async () => {
    const ticketId = await createTicket();
    const commentId = await createComment(ticketId);
    const res = await uploadAttachment(ticketId, users.memberCookie, pngFile, { commentId });
    expect(res.statusCode).toBe(201);
    expect((res.json() as AttachmentBody).commentId).toBe(commentId);
  });

  it("storage non configurato: 400 storage_not_configured, nessun put", async () => {
    const ticketId = await createTicket();
    activeStorage = null;
    const res = await uploadAttachment(ticketId, users.memberCookie, pngFile);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("storage_not_configured");
    expect(fakeStorage.putObject).not.toHaveBeenCalled();
  });

  it("MIME non in allowlist: 400 unsupported_type, nessuna riga, nessun put", async () => {
    const ticketId = await createTicket();
    const before = await testDb.db.select().from(attachments).where(eq(attachments.ticketId, ticketId));
    const res = await uploadAttachment(ticketId, users.memberCookie, {
      filename: "evil.exe",
      contentType: "application/x-msdownload",
      content: Buffer.from("MZ"),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("unsupported_type");
    expect(fakeStorage.putObject).not.toHaveBeenCalled();
    const after = await testDb.db.select().from(attachments).where(eq(attachments.ticketId, ticketId));
    expect(after.length).toBe(before.length);
  });

  it("file oltre 10 MB: 413 file_too_large, nessun put", async () => {
    const ticketId = await createTicket();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1024, 0x61);
    const res = await uploadAttachment(ticketId, users.memberCookie, {
      filename: "big.pdf",
      contentType: "application/pdf",
      content: big,
    });
    expect(res.statusCode).toBe(413);
    expect((res.json() as { code: string }).code).toBe("file_too_large");
    expect(fakeStorage.putObject).not.toHaveBeenCalled();
  });

  it("ticket inesistente: 404", async () => {
    const res = await uploadAttachment(
      "00000000-0000-0000-0000-000000000000",
      users.memberCookie,
      pngFile,
    );
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("ticket_not_found");
  });

  it("commentId di un altro ticket: 404 comment_not_found", async () => {
    const ticketA = await createTicket();
    const ticketB = await createTicket();
    const commentB = await createComment(ticketB);
    const res = await uploadAttachment(ticketA, users.memberCookie, pngFile, { commentId: commentB });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("comment_not_found");
    expect(fakeStorage.putObject).not.toHaveBeenCalled();
  });

  it("senza sessione: 401", async () => {
    const ticketId = await createTicket();
    const { payload, headers } = multipartBody(pngFile);
    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${ticketId}/attachments`,
      headers,
      payload,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/tickets/:ticketId/attachments", () => {
  it("ritorna i metadati ordinati con downloadUrl presigned dal fake", async () => {
    const ticketId = await createTicket();
    await uploadAttachment(ticketId, users.memberCookie, pngFile);
    await uploadAttachment(ticketId, users.memberCookie, {
      filename: "note.txt",
      contentType: "text/plain",
      content: Buffer.from("ciao"),
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/tickets/${ticketId}/attachments`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as (AttachmentBody & { downloadUrl: string })[];
    expect(list.length).toBe(2);
    expect(list[0]?.filename).toBe("screenshot.png");
    expect(list[1]?.filename).toBe("note.txt");
    for (const item of list) {
      expect(item.downloadUrl).toMatch(/^https:\/\/fake-storage\.test\//);
    }
  });

  it("ticket inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tickets/00000000-0000-0000-0000-000000000000/attachments",
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const ticketId = await createTicket();
    const res = await app.inject({
      method: "GET",
      url: `/api/tickets/${ticketId}/attachments`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/attachments/:attachmentId/download", () => {
  it("302 verso l'URL presigned", async () => {
    const ticketId = await createTicket();
    const upload = await uploadAttachment(ticketId, users.memberCookie, pngFile);
    const attachmentId = (upload.json() as AttachmentBody).id;

    const res = await app.inject({
      method: "GET",
      url: `/api/attachments/${attachmentId}/download`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/fake-storage\.test\//);
  });

  it("attachment inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/attachments/00000000-0000-0000-0000-000000000000/download",
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const ticketId = await createTicket();
    const upload = await uploadAttachment(ticketId, users.memberCookie, pngFile);
    const attachmentId = (upload.json() as AttachmentBody).id;
    const res = await app.inject({
      method: "GET",
      url: `/api/attachments/${attachmentId}/download`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/attachments/:attachmentId", () => {
  it("come uploader: 204, deleteObject chiamato, riga rimossa", async () => {
    const ticketId = await createTicket();
    const upload = await uploadAttachment(ticketId, users.memberCookie, pngFile);
    const body = upload.json() as AttachmentBody;
    const storageKey = (
      await testDb.db.select().from(attachments).where(eq(attachments.id, body.id))
    )[0]?.storageKey;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/attachments/${body.id}`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(204);
    expect(fakeStorage.deleteObject).toHaveBeenCalledWith(storageKey);
    const [row] = await testDb.db.select().from(attachments).where(eq(attachments.id, body.id));
    expect(row).toBeUndefined();
  });

  it("come altro utente non-admin: 403", async () => {
    const ticketId = await createTicket();
    // Caricato dall'admin, cancellato (tentato) dal member.
    const upload = await uploadAttachment(ticketId, users.adminCookie, pngFile);
    const body = upload.json() as AttachmentBody;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/attachments/${body.id}`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(403);
    const [row] = await testDb.db.select().from(attachments).where(eq(attachments.id, body.id));
    expect(row).toBeDefined();
  });

  it("come admin su allegato altrui: 204", async () => {
    const ticketId = await createTicket();
    const upload = await uploadAttachment(ticketId, users.memberCookie, pngFile);
    const body = upload.json() as AttachmentBody;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/attachments/${body.id}`,
      headers: { cookie: users.adminCookie },
    });
    expect(res.statusCode).toBe(204);
  });

  it("attachment inesistente: 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/attachments/00000000-0000-0000-0000-000000000000",
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("senza sessione: 401", async () => {
    const ticketId = await createTicket();
    const upload = await uploadAttachment(ticketId, users.memberCookie, pngFile);
    const body = upload.json() as AttachmentBody;
    const res = await app.inject({ method: "DELETE", url: `/api/attachments/${body.id}` });
    expect(res.statusCode).toBe(401);
  });
});
