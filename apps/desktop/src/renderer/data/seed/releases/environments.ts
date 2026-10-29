import type { ProjectEnvironment } from "../../types";
import { daysFromToday } from "../dates";
import { MERGE_SHAS } from "./releases";

// Gli ambienti dell'area 8a: pura anagrafica, mai un bersaglio che Stubwise
// esegue. La produzione ha i suoi server monitorati (`SRV-<n>`, il cui
// agente riporta il commit che gira); lo staging no.
//
// R-L2 (maintainer, 29 ott 2026): in un ambiente il server si sceglie per
// repository (`servers`, `repositoryId: null` = tutto il progetto), e un
// rilascio guarda solo quello della sua repository. Una sola produzione per
// progetto resta la regola.
//
// La numerazione dei server è fissata qui (ruling del controller, 28 ott;
// R-L2 per `SRV-4`): `SRV-1` ACQ (che non ha repository: vale per tutto il
// progetto), `SRV-2` la produzione di STW, `SRV-3` quella di AUD per
// `audin-app`, `SRV-4` quella di AUD per `audin-admin`. I server creati
// dall'app (area 8b) partono da `SRV-5`.
//
// - STW: la produzione riporta il merge di STW-V1, non quello di STW-V2.
// - AUD: `audin-app` è ferma ad AUD-V2 (il deploy di AUD-V3 è fallito);
//   `audin-scripts` non ha un server, i suoi rilasci non si seguono.

const at = (days: number, hm: string) => `${daysFromToday(-days)}T${hm}:00Z`;

export const ENVIRONMENTS: ProjectEnvironment[] = [
  {
    id: "env-stw-prod",
    projectId: "prj-stw",
    name: "Production",
    kind: "production",
    url: "https://demo.stubwise.test",
    servers: [
      {
        repositoryId: null,
        serverCode: "SRV-2",
        reportedSha: MERGE_SHAS.stwV1,
        reportedAt: at(0, "11:55"),
      },
    ],
  },
  {
    id: "env-stw-staging",
    projectId: "prj-stw",
    name: "Staging",
    kind: "staging",
    url: "https://staging.stubwise.test",
    servers: [],
  },
  {
    id: "env-aud-prod",
    projectId: "prj-aud",
    name: "Production",
    kind: "production",
    url: "https://app.audin.test",
    servers: [
      {
        repositoryId: "repo-aud",
        serverCode: "SRV-3",
        reportedSha: MERGE_SHAS.audV2,
        reportedAt: at(0, "11:50"),
      },
      {
        repositoryId: "repo-aud-admin",
        serverCode: "SRV-4",
        reportedSha: "3e5a7c9b1d2f4e6a8c0b2d4f6e8a1c3b5d7f9e0a",
        reportedAt: at(0, "11:52"),
      },
    ],
  },
  {
    id: "env-aud-staging",
    projectId: "prj-aud",
    name: "Staging",
    kind: "staging",
    url: "https://staging.audin.test",
    servers: [],
  },
  {
    id: "env-acq-prod",
    projectId: "prj-acq",
    name: "Production",
    kind: "production",
    url: "https://portale.acquedottocolline.test",
    servers: [
      {
        repositoryId: null,
        serverCode: "SRV-1",
        reportedSha: "e9f8d7c6b5a4e3f2d1c0b9a8f7e6d5c4b3a2f1e0",
        reportedAt: at(0, "11:58"),
      },
    ],
  },
];
