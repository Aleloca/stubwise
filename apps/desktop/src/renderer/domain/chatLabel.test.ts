import { describe, expect, it } from "vitest";
import { channelName, splitChannelLabel } from "./chatLabel";

const codeOf = (id: string) => ({ "prj-aud": "AUD" })[id];
const nameOf = (id: string) => ({ "p-marco": "Marco Bellini", "p-laura": "Laura Costa" })[id];

describe("il nome di un canale, una regola sola", () => {
  it("di progetto, generale, DM", () => {
    const project = { kind: "project" as const, name: "general", projectId: "prj-aud", memberIds: [] };
    expect(channelName(project, "p-giulia", codeOf, nameOf)).toEqual({
      code: "AUD",
      name: "general",
      prefix: "AUD · ",
      label: "AUD · general",
    });
    const general = { kind: "general" as const, name: "announcements", projectId: null, memberIds: [] };
    expect(channelName(general, "p-giulia", codeOf, nameOf).label).toBe("# announcements");
    const dm = {
      kind: "dm" as const,
      name: "",
      projectId: null,
      memberIds: ["p-giulia", "p-marco", "p-laura"],
    };
    expect(channelName(dm, "p-giulia", codeOf, nameOf)).toMatchObject({
      code: null,
      prefix: "",
      label: "Marco Bellini, Laura Costa",
    });
  });

  it("un'etichetta composta torna nei suoi pezzi, «·» compreso", () => {
    expect(splitChannelLabel("AUD · general")).toMatchObject({
      code: "AUD",
      prefix: "AUD · ",
      name: "general",
    });
    expect(splitChannelLabel("# announcements")).toMatchObject({ code: "#", name: "announcements" });
    expect(splitChannelLabel("Marco Bellini, Laura Costa")).toMatchObject({
      code: null,
      prefix: "",
      name: "Marco Bellini, Laura Costa",
    });
  });
});
