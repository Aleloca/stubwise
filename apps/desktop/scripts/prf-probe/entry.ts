// La pagina della prova in Chromium di I-A (`scripts/verify-prf-capture.mjs`):
// il boot VERO della cassaforte nel browser (le primitive, i freeze, il
// worker), poi la cerimonia e la consegna della PRF al worker. Non entra in
// nessuna build dell'app.
import "../../src/renderer/data/backend/real/vaultBrowser/boot";
import { request, stashPrf } from "../../src/renderer/data/backend/real/vaultBrowser/client";
import { ceremony } from "../../src/renderer/data/backend/real/vaultBrowser/webauthn";

(window as unknown as { __probe: unknown }).__probe = { ceremony, stashPrf, request };
