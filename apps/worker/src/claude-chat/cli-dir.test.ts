import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chatCwd,
  chatSessionIdsInCliProjects,
  cliProjectDirName,
  removeChatCliState,
  removeLegacyChatCliDirs,
} from "./cli-dir.js";

// La cwd di una conversazione è DETERMINISTICA (il CLI indicizza `--resume`
// per cwd) e le sue trascrizioni stanno in `<CLAUDE_CONFIG_DIR>/projects/<cwd
// con ogni carattere non alfanumerico come «-»>`: si cancellano con la
// conversazione e con la potatura.

const ID = "7f1c2a1e-0000-4000-8000-000000000001";

describe("le cartelle del CLI di una conversazione", () => {
  it("la cwd è la stessa a ogni turno, e il nome del progetto del CLI è quello che il CLI usa", () => {
    expect(chatCwd(ID, "/tmp")).toBe(`/tmp/stubwise-chat/${ID}`);
    expect(chatCwd(ID, "/tmp")).toBe(chatCwd(ID, "/tmp"));
    expect(cliProjectDirName(`/private/tmp/stubwise-chat/${ID}`)).toBe(`-private-tmp-stubwise-chat-${ID}`);
    expect(cliProjectDirName("/var/folders/x_y/T/stubwise-chat/a.b")).toBe("-var-folders-x-y-T-stubwise-chat-a-b");
  });

  it("rimuove cwd e trascrizioni (col percorso dato E con quello reale); niente se non esistono", async () => {
    const base = await mkdtemp(join(tmpdir(), "chat-cli-"));
    const config = join(base, "config");
    const cwd = chatCwd(ID, base);
    await mkdir(cwd, { recursive: true });
    const real = await realpath(cwd);
    for (const name of new Set([cliProjectDirName(cwd), cliProjectDirName(real)])) {
      await mkdir(join(config, "projects", name), { recursive: true });
      await writeFile(join(config, "projects", name, "s.jsonl"), "{}");
    }
    const other = join(config, "projects", cliProjectDirName(chatCwd("altro", base)));
    await mkdir(other, { recursive: true });
    await removeChatCliState(ID, { tmp: base, configDir: config });
    expect(await readdir(join(config, "projects"))).toEqual([cliProjectDirName(chatCwd("altro", base))]);
    await expect(readdir(cwd)).rejects.toThrow();
    await removeChatCliState(ID, { tmp: base, configDir: config });
  });

  it("le conversazioni che hanno trascrizioni nel CLI, lette dai nomi delle cartelle", async () => {
    const base = await mkdtemp(join(tmpdir(), "chat-cli-"));
    const config = join(base, "config");
    const real = await realpath(base);
    await mkdir(join(config, "projects", cliProjectDirName(chatCwd(ID, real))), { recursive: true });
    await mkdir(join(config, "projects", "-Users-qualcuno-repo"), { recursive: true });
    expect(await chatSessionIdsInCliProjects({ tmp: base, configDir: config })).toEqual([ID]);
    expect(await chatSessionIdsInCliProjects({ tmp: base, configDir: join(base, "manca") })).toEqual([]);
  });

  it("le trascrizioni dei turni di prima (cwd casuale per turno) si tolgono; quelle nuove restano", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "chat-cli-")));
    const config = join(base, "config");
    const legacy = cliProjectDirName(join(base, "stubwise-chat-Ab12Cd"));
    const current = cliProjectDirName(chatCwd(ID, base));
    for (const name of [legacy, current, "-Users-qualcuno-repo"]) await mkdir(join(config, "projects", name), { recursive: true });
    expect(await removeLegacyChatCliDirs({ tmp: base, configDir: config })).toBe(1);
    expect((await readdir(join(config, "projects"))).sort()).toEqual(["-Users-qualcuno-repo", current].sort());
  });
});
