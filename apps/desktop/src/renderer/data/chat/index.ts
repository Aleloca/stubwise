// La Chat (area 4) come la espone `api.ts`: `api.chat.<funzione>`. Le
// letture e le scritture filtrano per chi guarda (visibility.ts); gli
// aiutanti degli eventi simulano ciò che nel prototipo non ha ancora una
// scrittura (Release, brief, PR sulla piattaforma).
export {
  getChannel,
  getMessage,
  listChannelMembers,
  listChannels,
  listMentions,
  listMessages,
  listQuestions,
  listThread,
  listThreadsWithNews,
  searchChat,
} from "./reads";
export {
  CHAT_EVENT_KINDS,
  DM_MAX_PEOPLE,
  archiveChannel,
  createChannel,
  createRequestFromMessage,
  createTaskFromMessage,
  deleteChannel,
  deleteMessage,
  dismissQuestion,
  editMessage,
  inviteMembers,
  joinChannel,
  leaveChannel,
  markRead,
  markThreadRead,
  normalizeChannelName,
  openDm,
  removeMember,
  sendMessage,
  setNotifyLevel,
  setPublishedEvents,
  setThreadFollow,
  toggleReaction,
  updateChannel,
} from "./writes";
export {
  callText,
  cancelChatProposal,
  completeEditedChatProposal,
  confirmChatProposal,
  editChatProposal,
  retryClaudeReply,
  stopClaudeReply,
  whenClaudeIdle,
} from "./claude";
export {
  publishChatEvent,
  publishReleasePage,
  publishWeeklyBrief,
  recordPullRequestEvent,
} from "./events";
export {
  channelStream,
  onChatChange,
  subscribeChat,
  threadStream,
  type ChatStreamId,
} from "../stream";
