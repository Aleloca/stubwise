import { describe, expect, it } from "vitest";

import { checkPluginChangeset, parseChangesetPackages } from "./plugin-changeset.mjs";

const both = `---
"@stubwise/claude-plugin": minor
"@stubwise/mcp": minor
---

Skill aggiornata.
`;

const pluginOnly = `---
'@stubwise/claude-plugin': patch
---

Solo il plugin.
`;

describe("parseChangesetPackages", () => {
  it("legge i pacchetti del frontmatter, con virgolette doppie o singole", () => {
    expect(parseChangesetPackages(both)).toEqual(["@stubwise/claude-plugin", "@stubwise/mcp"]);
    expect(parseChangesetPackages(pluginOnly)).toEqual(["@stubwise/claude-plugin"]);
  });

  it("un file senza frontmatter non nomina niente", () => {
    expect(parseChangesetPackages("# README\n")).toEqual([]);
  });
});

describe("checkPluginChangeset", () => {
  const skill = "plugins/stubwise/skills/stubwise/SKILL.md";

  it("plugin non toccato: ok", () => {
    expect(
      checkPluginChangeset({
        changedFiles: ["packages/mcp/src/client.ts"],
        changesets: [],
        pluginVersionChanged: false,
      }).ok,
    ).toBe(true);
  });

  it("plugin toccato senza changeset: ko, e dice cosa aggiungere", () => {
    const result = checkPluginChangeset({
      changedFiles: [skill],
      changesets: [],
      pluginVersionChanged: false,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("@stubwise/claude-plugin");
    expect(result.message).toContain("@stubwise/mcp");
  });

  it("changeset col solo plugin: ko, serve anche @stubwise/mcp", () => {
    const result = checkPluginChangeset({
      changedFiles: [skill],
      changesets: [pluginOnly],
      pluginVersionChanged: false,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("@stubwise/mcp");
  });

  it("changeset con plugin e mcp: ok", () => {
    expect(
      checkPluginChangeset({ changedFiles: [skill], changesets: [both], pluginVersionChanged: false })
        .ok,
    ).toBe(true);
  });

  it("versione del plugin alzata (la PR di versioning): ok", () => {
    expect(
      checkPluginChangeset({
        changedFiles: ["plugins/stubwise/package.json", "plugins/stubwise/CHANGELOG.md"],
        changesets: [],
        pluginVersionChanged: true,
      }).ok,
    ).toBe(true);
  });

  it("solo il CHANGELOG del plugin: ok", () => {
    expect(
      checkPluginChangeset({
        changedFiles: ["plugins/stubwise/CHANGELOG.md"],
        changesets: [],
        pluginVersionChanged: false,
      }).ok,
    ).toBe(true);
  });

  it("un altro plugin in plugins/ non conta", () => {
    expect(
      checkPluginChangeset({
        changedFiles: ["plugins/other/README.md"],
        changesets: [],
        pluginVersionChanged: false,
      }).ok,
    ).toBe(true);
  });
});
