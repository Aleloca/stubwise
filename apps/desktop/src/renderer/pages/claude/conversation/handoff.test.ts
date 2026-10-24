import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../../data/api";
import { runBeforePersonaChange } from "../../../data/session";
import { handOffFirstMessage, takeFirstMessage } from "./handoff";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("primo messaggio affidato", () => {
  it("si prende una volta sola", () => {
    handOffFirstMessage("cv-1", { text: "Hello", attachments: [] });
    expect(takeFirstMessage("cv-1")).toEqual({ text: "Hello", attachments: [] });
    expect(takeFirstMessage("cv-1")).toBeNull();
  });

  it("un ripristino dello stato lo dimentica", () => {
    handOffFirstMessage("cv-1", { text: "Hello", attachments: [] });
    resetApi();
    expect(takeFirstMessage("cv-1")).toBeNull();
  });

  it("cambiando persona nessuno lo manda a nome dell'altra", () => {
    handOffFirstMessage("cv-1", { text: "Hello", attachments: [] });
    runBeforePersonaChange();
    expect(takeFirstMessage("cv-1")).toBeNull();
  });
});
