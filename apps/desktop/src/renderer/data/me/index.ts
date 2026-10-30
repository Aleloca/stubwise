// Le Preferenze personali (area 9a) come le espone `api.ts`: `api.me.<funzione>`.
// Account (`account.ts`), le caselle Google (`google.ts`), Sicurezza
// (`security.ts`), Token (`tokens.ts`) e il comando di Claude Code
// (`claudeCode.ts`). `callWithToken` e `issueToken` NON si esportano: il
// primo simula un tool (lo usano solo i test), il secondo è il pezzo comune
// delle due creazioni di token.
export { changePassword, updateProfile, type ProfileInput } from "./account";
export {
  connectMailbox,
  disconnectMailbox,
  listMyMailboxes,
  reconnectMailbox,
  setProposals,
} from "./google";
export {
  addPasskey,
  confirmTotp,
  endSession,
  getMySecurity,
  regenerateBackupCodes,
  removePasskey,
  renamePasskey,
  startTotpSetup,
  type ConfirmTotpResult,
} from "./security";
export { createToken, listTokens, revokeToken } from "./tokens";
export { createClaudeCodeCommand } from "./claudeCode";
export type * from "./types";
