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

export const WORKSPACE_CHANGE_TYPES: readonly ChangeType[] = [
  instance("workspace.created"),
  instance("workspace.renamed"),
  instance("workspace.deleted"),
  instance("workspace.project_added"),
  instance("workspace.project_removed"),
  instance("workspace.member_added"),
  instance("workspace.member_role_changed"),
  instance("workspace.member_removed"),
];

registerChangeTypes(WORKSPACE_CHANGE_TYPES);
