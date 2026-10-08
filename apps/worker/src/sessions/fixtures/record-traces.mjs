// apps/worker/src/sessions/fixtures/record-traces.mjs
// Uso (NON in CI, serve un login claude):
//   npx -y @anthropic-ai/claude-code@2.1.287 --version   # verifica il pin
//   node apps/worker/src/sessions/fixtures/record-traces.mjs <claude-bin>
// Scrive una .jsonl per scenario accanto a questo file. Ricontrolla a mano
// che non contengano dati personali prima del commit.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bin = process.argv[2] ?? "claude";
const user = (content) => ({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });

const scenarios = {
  "two-turns": [[0, user("Say ONE.")], ["afterResult", user("Say TWO.")]],
  "mid-turn-message": [[0, user("Run `sleep 6; echo done` and report.")], [3000, user("End with BANANA.")]],
  "interrupt-then-message": [
    [0, user("Run `sleep 20; echo done` and report.")],
    [5000, { type: "control_request", request_id: "int-1", request: { subtype: "interrupt" } }],
    [5200, user("Forget it. Reply only OK.")],
  ],
};

for (const [name, steps] of Object.entries(scenarios)) {
  const cwd = mkdtempSync(join(tmpdir(), "trace-"));
  const p = spawn(bin, [
    "-p", "--model", "haiku", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--include-partial-messages", "--permission-mode", "default",
    "--allowedTools", "Bash", "--setting-sources", "",
  ], { cwd });
  const lines = [];
  let buf = "";
  let grace = null;
  let sentAfterResult = false;
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      if (grace) clearTimeout(grace);
      if (line.includes('"type":"result"')) {
        const next = steps.find(([at]) => at === "afterResult");
        if (next && !sentAfterResult) {
          sentAfterResult = true;
          p.stdin.write(JSON.stringify(next[1]) + "\n");
        } else grace = setTimeout(() => p.stdin.end(), 2000);
      }
    }
  });
  for (const [at, msg] of steps) {
    if (typeof at === "number") setTimeout(() => p.stdin.write(JSON.stringify(msg) + "\n"), at);
  }
  await new Promise((r) => p.on("exit", r));
  writeFileSync(join(here, `${name}.jsonl`), lines.join("\n") + "\n");
  console.log(name, lines.length, "righe");
}
