import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Il motore delle Automations sta in shared perché lo usano server, worker e
// app (area 7, fetta 1, task 0): niente import dal renderer né da fuori del
// package, e niente DOM (gira anche nel worker).

const dir = new URL(".", import.meta.url).pathname;
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

describe("il motore delle Automations è autonomo", () => {
  it("importa solo dal suo modulo (e da `../claude/work.js` per AiBlock)", () => {
    const bad: string[] = [];
    for (const [file, src] of sources)
      for (const m of src.matchAll(/from "([^"]+)"/g))
        if (!/^\.\/[a-zA-Z]+\.js$/.test(m[1]!) && m[1] !== "../claude/work.js") bad.push(`${file}: ${m[1]}`);
    expect(bad).toEqual([]);
  });

  it("non usa il DOM", () => {
    const bad = sources
      .filter(([, src]) => /\b(window|document|localStorage|sessionStorage|navigator)\./.test(src))
      .map(([file]) => file);
    expect(bad).toEqual([]);
  });
});
