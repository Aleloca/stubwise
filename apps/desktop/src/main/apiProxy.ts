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
  if (size > MAX_BODY) return null;
  return { method: r.method as ApiMethod, path: r.path, headers, ...(body !== undefined ? { body } : {}) };
}

const fail = (status: number, code: string): ApiProxyResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code, message: code }),
});

const isText = (type: string) => /^(text\/|application\/(json|problem\+json|x-ndjson))/i.test(type);

export interface ApiProxyDeps {
  instanceUrl: () => string | null;
  token: () => string | null;
  onUnauthorized: () => void;
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
  if (res.status === 401) deps.onUnauthorized();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const type = res.headers.get("content-type") ?? "";
  const body = type === "" || isText(type) ? await res.text() : await res.arrayBuffer();
  return { status: res.status, headers, body };
}

/** `open:web`: un percorso dell'istanza (`/tickets/<id>`), mai un altro host o schema. */
export function isWebPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > MAX_PATH) return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  return !/[\\\s]/.test(path) && !/[\u0000-\u001f\u007f]/.test(path);
}
