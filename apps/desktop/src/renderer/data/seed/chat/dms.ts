import type { ChatMessage } from "../../types";
import { at, channelFlow, say, task, type Spec } from "./helpers";

// I messaggi diretti: li legge solo chi partecipa, nemmeno il full admin.

const giuliaMarco: Spec[] = [
  say(
    "p-giulia",
    at(6, "10:00"),
    "Can you look at Claude's question on the CSV import? AUD-3 is waiting on it.",
    { cites: [task("t-aud-3")] },
  ),
  say("p-marco", at(6, "10:30"), "Answered: email first, then phone. Same rule as the docs."),
  say("p-giulia", at(6, "10:31"), "Thanks!"),
  say("p-marco", at(0, "11:45"), "Billing email preview tomorrow morning, I'll ping you here."),
];

const giuliaLaura: Spec[] = [
  say("p-laura", at(10, "14:00"), "Do you have ten minutes for the department homes?"),
  say("p-giulia", at(10, "14:05"), "After 15:00, yes."),
  say("p-giulia", at(3, "17:00"), "Thanks for the review on STW-10, I applied everything.", {
    cites: [task("t-stw-10")],
    react: [["👍", ["p-laura"]]],
  }),
];

const lauraMarco: Spec[] = [
  say(
    "p-marco",
    at(2, "18:00"),
    "I'm off next Friday. Stefano covers the export if anything comes up.",
  ),
  say("p-laura", at(2, "18:10"), "Ok, enjoy 👍"),
];

const giuliaRoberta: Spec[] = [
  say(
    "p-roberta",
    at(8, "09:30"),
    "Can you prepare the list of clients up for renewal for the all-hands?",
  ),
  say("p-giulia", at(8, "09:45"), "Sure, by Wednesday."),
  say("p-giulia", at(1, "16:00"), "Here it is: eleven clients, four with an open request."),
  say("p-roberta", at(0, "11:00"), "Received, thanks."),
];

const davideSara: Spec[] = [
  say("p-sara", at(4, "10:00"), "A Cantina Bellavista customer asked about gift boxes again."),
  say("p-davide", at(4, "10:12"), "Point them to the request, it's being refined."),
];

const launchWeek: Spec[] = [
  say(
    "p-laura",
    at(7, "09:00"),
    "Small group for the logistics of the launch week: who's where, who brings what.",
  ),
  say("p-elena", at(1, "17:00"), "Who brings the projector to the client day?", {
    replies: [say("p-marco", at(1, "17:10"), "The office one is broken, I'd rent one.")],
  }),
  say("p-sara", at(0, "10:30"), "I can pick up a rented projector on Monday morning."),
];

export const DM_MESSAGES: ChatMessage[] = [
  ...channelFlow("dm-giulia-marco", giuliaMarco),
  ...channelFlow("dm-giulia-laura", giuliaLaura),
  ...channelFlow("dm-laura-marco", lauraMarco),
  ...channelFlow("dm-giulia-roberta", giuliaRoberta),
  ...channelFlow("dm-davide-sara", davideSara),
  ...channelFlow("dm-launch-week", launchWeek),
];
