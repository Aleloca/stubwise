import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import { workspaceListSchema } from "./workspace.js";

describe("I3: workspaceListSchema.canManage è additivo", () => {
  it("una risposta di un server di prima (senza canManage) si legge come false", () => {
    expect(readerSchema(workspaceListSchema).parse({ items: [] })).toEqual({ items: [], canManage: false });
  });
});
