/*
 * Alla fine della suite: toglie il container Postgres di QUESTA run (l'id lo
 * scrive `start-stack.mjs` in `<tmp>/stubwise-e2e-app/stack.json`). Playwright
 * chiude lo stack prima che il container si fermi da sé, e in locale
 * resterebbe acceso; i container di altre run o di altre sessioni non si
 * toccano. In CI il runner è effimero, e il passo è innocuo.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export default function teardown() {
  const file = path.join(os.tmpdir(), "stubwise-e2e-app", "stack.json");
  if (!existsSync(file)) return;
  const { containerId } = JSON.parse(readFileSync(file, "utf8"));
  if (!containerId) return;
  try {
    execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
  } catch {
    // Già fermo e tolto: niente da fare.
  }
}
