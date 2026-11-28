import { registerChangeTypes } from "../changelog/registry";
import type { ChangeType } from "../changelog/types";

// Le voci del registro delle workspace (shape `workspaces.md`): d'istanza,
// lette da chi le gestisce (`workspaces.manage`). La frase sta in
// `changelog.kinds.workspace.<…>`, il gruppo in `changelog.groups.workspaces`.

const instance = (kind: string): ChangeType => ({
  kind,
  templateKey: `changelog.kinds.${kind}`,
  readPermission: "workspaces.manage",
  scope: "instance",
  group: "workspaces",
});
// Le voci di un progetto messo in una workspace o tolto: scritte SUL progetto,
// lette da chi ne gestisce i membri (come `member.*`). Uno spostamento ne
// scrive due: `project_removed` dalla vecchia, `project_added` nella nuova.
const project = (kind: string): ChangeType => ({
  kind,
  templateKey: `changelog.kinds.${kind}`,
  readPermission: "project.members.manage",
  scope: "project",
  group: "members",
});

// Gli stessi tipi del server (lotto 3 di 54, `catalogParity.test.ts`).
export const WORKSPACE_CHANGE_TYPES: readonly ChangeType[] = [
  instance("workspace.created"),
  instance("workspace.updated"),
  instance("workspace.deleted"),
  instance("workspace.member_added"),
  instance("workspace.member_role_changed"),
  instance("workspace.member_removed"),
  project("workspace.project_added"),
  project("workspace.project_removed"),
];

registerChangeTypes(WORKSPACE_CHANGE_TYPES);
