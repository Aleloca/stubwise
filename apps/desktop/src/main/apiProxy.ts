import { endsSession } from "@stubwise/shared";

// Il proxy delle richieste API dell'app desktop (integrazione area 2, fetta
// 1): il renderer non fa rete (CSP `connect-src 'self'`) e non vede il token;
// chiede `api:request` e il main la manda all'istanza col bearer. Solo
// percorsi sotto `/api/`, senza risalite né host diversi.

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface ApiProxyRequest {
  method: ApiMethod;
  path: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface ApiProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string | ArrayBuffer;
}

/** Le intestazioni che il renderer non sceglie: le mette il main, o nessuno. */
const DROPPED_HEADERS = new Set(["authorization", "cookie", "host", "origin", "referer", "connection"]);
const MAX_PATH = 4096;
const MAX_BODY = 15 * 1024 * 1024;
/**
 * L'upload di un allegato della Chat (area 4, fetta 4): fino a 25 MB per file
 * (`CHAT_ATTACHMENT_MAX_BYTES`), più il multipart. Vale SOLO per questa rotta:
 * altrove il tetto resta `MAX_BODY`.
 */
const MAX_CHAT_UPLOAD_BODY = 26 * 1024 * 1024;
const CHAT_UPLOAD_PATH = /^\/api\/chat\/channels\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/attachments$/i;

function bodyLimit(method: string, path: string): number {
  return method === "POST" && CHAT_UPLOAD_PATH.test(path) ? MAX_CHAT_UPLOAD_BODY : MAX_BODY;
}

/** Un percorso sotto `/api/`, nient'altro: niente schema, host, `..`, `//`, `\` o frammento. */
export function isAllowedApiPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > MAX_PATH) return false;
  if (!path.startsWith("/api/")) return false;
  if (/[\\#\s]/.test(path) || /[\u0000-\u001f\u007f]/.test(path)) return false;
  const pathname = path.split("?")[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  for (const p of [pathname, decoded]) {
    if (p.includes("//") || p.includes("\\")) return false;
    if (p.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  }
  return true;
}

function parseRequest(raw: unknown): ApiProxyRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.method !== "string" || !METHODS.has(r.method)) return null;
  if (!isAllowedApiPath(r.path)) return null;
  const headers: Record<string, string> = {};
  if (r.headers !== undefined) {
    if (!r.headers || typeof r.headers !== "object") return null;
    for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
      if (typeof v !== "string") return null;
      const key = k.toLowerCase();
      if (!DROPPED_HEADERS.has(key)) headers[key] = v;
    }
  }
  let body: string | ArrayBuffer | undefined;
  if (typeof r.body === "string") body = r.body;
  else if (r.body instanceof ArrayBuffer) body = r.body;
  else if (ArrayBuffer.isView(r.body)) {
    const view = r.body as ArrayBufferView;
    body = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer;
  } else if (r.body !== undefined && r.body !== null) return null;
  const size = typeof body === "string" ? body.length : (body?.byteLength ?? 0);
  if (size > bodyLimit(r.method, r.path)) return null;
  return { method: r.method as ApiMethod, path: r.path, headers, ...(body !== undefined ? { body } : {}) };
}

const fail = (status: number, code: string): ApiProxyResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code, message: code }),
});

const isText = (type: string) => /^(text\/|application\/(json|problem\+json|x-ndjson))/i.test(type);

/** Il `code` di un corpo d'errore JSON, se c'è. */
function codeOf(body: string | ArrayBuffer): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === "string" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

export interface ApiProxyDeps {
  instanceUrl: () => string | null;
  token: () => string | null;
  /**
   * La sessione è finita. Riceve il token con cui è partita la richiesta: chi
   * cancella lo fa solo se è ancora quello corrente (un login nel frattempo
   * non va perso per un 401 della sessione di prima).
   */
  onUnauthorized: (usedToken: string) => void;
  fetch?: typeof fetch;
}

/** `api:request`: valida, aggiunge il bearer, inoltra; un 401 cancella il token. */
export async function handleApiRequest(raw: unknown, deps: ApiProxyDeps): Promise<ApiProxyResponse> {
  const req = parseRequest(raw);
  if (!req) return fail(400, "invalid_request");
  const base = deps.instanceUrl();
  if (!base) return fail(400, "no_instance");
  const token = deps.token();
  if (!token) return fail(401, "unauthenticated");
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${base}${req.path}`, {
      method: req.method,
      headers: { ...req.headers, authorization: `Bearer ${token}` },
      ...(req.body !== undefined ? { body: req.body } : {}),
      redirect: "manual",
    });
  } catch {
    return fail(502, "network_error");
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const type = res.headers.get("content-type") ?? "";
  const body = type === "" || isText(type) ? await res.text() : await res.arrayBuffer();
  // Solo un 401 di SESSIONE cancella il token (un codice di riconferma
  // sbagliato è un 401 con la sessione viva): la regola è `endsSession`.
  if (res.status === 401 && endsSession(req.path, res.status, codeOf(body))) deps.onUnauthorized(token);
  return { status: res.status, headers, body };
}

/** `open:web`: un percorso dell'istanza (`/tickets/<id>`), mai un altro host o schema. */
export function isWebPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > MAX_PATH) return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  return !/[\\\s]/.test(path) && !/[\u0000-\u001f\u007f]/.test(path);
}
