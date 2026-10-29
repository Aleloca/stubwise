// L'ingresso e la riconferma (area 9a) come li espone `api.ts`:
// `api.auth.<funzione>`. Solo le funzioni dell'API: `requireReauth`,
// `attemptSecondFactor` e `markReauthenticated` le importano le scritture
// direttamente da `./reauth`.
export {
  enrollDuringReauth,
  reauthenticate,
  type SecondFactorInput,
  type SecondFactorResult,
  type TotpSetup,
} from "./reauth";
