import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import { projectMemberSchema } from "./roles.js";

describe("M4: projectMemberSchema, campi della workspace additivi", () => {
  it("una risposta di un server di prima (senza explicit né workspaceId) si legge: esplicito, nessuna workspace", () => {
    const old = {
      userId: "40000000-0000-4000-8000-000000000002",
      email: "bea@example.com",
      avatarUrl: null,
      roleId: "30000000-0000-4000-8000-000000000002",
      roleName: "Developer",
      createdAt: "2026-10-22T10:00:00.000Z",
    };
    expect(readerSchema(projectMemberSchema).parse(old)).toMatchObject({ explicit: true, workspaceId: null, permissions: [] });
  });
});
