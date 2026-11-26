// `@backend/access` nella build app (integrazione area 2, fetta 1), con le
// firme di `data/accessFacts.ts`: i fatti vengono dal `Viewer` che il server
// calcola (`/api/auth/me`), non dal client. Il server dà i permessi di
// progetto per i progetti in cui la persona è membro; un full admin è membro
// implicito di ogni progetto (`docs/invariants/permissions.md`).
import type * as Fake from "../../accessFacts";
import { NO_SESSION_PERSON_ID } from "../../session";

export const isActiveViewer: typeof Fake.isActiveViewer = (viewer) =>
  viewer.personId !== "" && viewer.personId !== NO_SESSION_PERSON_ID;

export const seesProject: typeof Fake.seesProject = (viewer, projectId) =>
  viewer.instancePermissions.includes("instance.full_admin") ||
  Object.prototype.hasOwnProperty.call(viewer.projectPermissions, projectId);
