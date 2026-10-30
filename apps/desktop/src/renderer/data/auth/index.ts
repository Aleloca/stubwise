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
export {
  getEntry,
  login,
  loginSecondFactor,
  logout,
  passMinutes,
  prototypeAccounts,
  readEntry,
  type EntryStage,
  type LoginResult,
  type LoginSecondFactorResult,
} from "./login";
export {
  getInvite,
  register,
  simulateInviteLink,
  type InviteLookup,
  type RegisterResult,
} from "./register";
export { createFirstAdmin, isInstanceEmpty, type FirstAdminResult } from "./setup";
export { resetToEmptyInstance } from "./emptyInstance";
