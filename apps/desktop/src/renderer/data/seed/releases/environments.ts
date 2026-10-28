import type { ProjectEnvironment } from "../../types";
import { daysFromToday } from "../dates";
import { MERGE_SHAS } from "./releases";

// Gli ambienti dell'area 8a: pura anagrafica, mai un bersaglio che Stubwise
// esegue. La produzione ha il suo server monitorato (`SRV-<n>`, il cui
// agente riporta il commit che gira); lo staging no. ACQ ha `SRV-1`, il
// server dell'allarme di memoria già nel seme.
//
// - STW: la produzione riporta il merge di STW-V1, non quello di STW-V2.
// - AUD: la produzione è ferma ad AUD-V1 (il deploy di AUD-V2 è fallito).

const at = (days: number, hm: string) => `${daysFromToday(-days)}T${hm}:00Z`;

export const ENVIRONMENTS: ProjectEnvironment[] = [
  {
    id: "env-stw-prod",
    projectId: "prj-stw",
    name: "Production",
    kind: "production",
    url: "https://demo.stubwise.test",
    serverCode: "SRV-2",
    reportedSha: MERGE_SHAS.stwV1,
    reportedAt: at(0, "11:55"),
  },
  {
    id: "env-stw-staging",
    projectId: "prj-stw",
    name: "Staging",
    kind: "staging",
    url: "https://staging.stubwise.test",
    serverCode: null,
    reportedSha: null,
    reportedAt: null,
  },
  {
    id: "env-aud-prod",
    projectId: "prj-aud",
    name: "Production",
    kind: "production",
    url: "https://app.audin.test",
    serverCode: "SRV-3",
    reportedSha: MERGE_SHAS.audV1,
    reportedAt: at(0, "11:50"),
  },
  {
    id: "env-aud-staging",
    projectId: "prj-aud",
    name: "Staging",
    kind: "staging",
    url: "https://staging.audin.test",
    serverCode: null,
    reportedSha: null,
    reportedAt: null,
  },
  {
    id: "env-acq-prod",
    projectId: "prj-acq",
    name: "Production",
    kind: "production",
    url: "https://portale.acquedottocolline.test",
    serverCode: "SRV-1",
    reportedSha: "e9f8d7c6b5a4e3f2d1c0b9a8f7e6d5c4b3a2f1e0",
    reportedAt: at(0, "11:58"),
  },
];
