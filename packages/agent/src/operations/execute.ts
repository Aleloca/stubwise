import type { ServerAction } from "@stubwise/shared";

/**
 * Area 8, F4b: the FIXED table from an action of the closed set to ONE call on
 * the Docker Engine API. There is no generic branch: an action that is not in
 * this table cannot be executed (and `verifyCommand` already refused it). The
 * container name went through Docker's name regex and is URL-encoded anyway.
 */

export interface DockerCall {
  method: "GET" | "POST";
  path: string;
}

/** One request on the Docker socket; returns status code and body text. */
export type DockerRequest = (call: DockerCall) => Promise<{ statusCode: number; body: string }>;

const enc = encodeURIComponent;
const PRUNE_PATH = {
  images_unused: `/images/prune?filters=${enc(JSON.stringify({ dangling: ["false"] }))}`,
  build_cache: "/build/prune",
  stopped_containers: "/containers/prune",
} as const;

export function dockerCallFor(action: ServerAction, now: Date = new Date()): DockerCall {
  switch (action.action) {
    case "container.restart":
      return { method: "POST", path: `/containers/${enc(action.params.container)}/restart?t=${action.params.timeoutSeconds}` };
    case "container.stop":
      return { method: "POST", path: `/containers/${enc(action.params.container)}/stop?t=${action.params.timeoutSeconds}` };
    case "container.start":
      return { method: "POST", path: `/containers/${enc(action.params.container)}/start` };
    case "docker.prune":
      return { method: "POST", path: PRUNE_PATH[action.params.what] };
    case "container.logs": {
      const since = Math.floor(now.getTime() / 1000) - action.params.sinceMinutes * 60;
      return { method: "GET", path: `/containers/${enc(action.params.container)}/logs?stdout=1&stderr=1&tail=${action.params.lines}&since=${since}` };
    }
    case "container.state":
      return { method: "GET", path: `/containers/${enc(action.params.container)}/json` };
  }
}

/** Strip Docker's 8-byte multiplexing headers from a non-TTY log stream (best effort). */
function demux(body: string): string {
  const buf = Buffer.from(body, "latin1");
  if (buf.length < 8 || (buf[0] !== 1 && buf[0] !== 2) || buf[1] !== 0) return body;
  const out: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(out).toString("utf8");
}

/** Runs the action; the output is UNTRUSTED text for the server (truncated there). */
export async function executeAction(request: DockerRequest, action: ServerAction, now: Date = new Date()): Promise<{ exitCode: number; output: string }> {
  try {
    const { statusCode, body } = await request(dockerCallFor(action, now));
    const ok = statusCode >= 200 && statusCode < 300;
    let output = body;
    if (ok && action.action === "container.logs") output = demux(body);
    if (ok && action.action === "container.state") {
      try {
        const j = JSON.parse(body) as { State?: unknown; RestartCount?: unknown; Config?: { Image?: unknown } };
        output = JSON.stringify({ state: j.State ?? null, restartCount: j.RestartCount ?? null, image: j.Config?.Image ?? null });
      } catch {
        output = body;
      }
    }
    return { exitCode: ok ? 0 : statusCode, output: output.slice(0, 64 * 1024) };
  } catch (error) {
    return { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
  }
}
