import type {
  ConversationId,
  EntryId,
  SubmissionId,
} from "@earendil-works/pi-durable";

const isStoredId = (n: number) => Number.isSafeInteger(n) && n > 0;

export function isEntryId(n: number): n is EntryId {
  return isStoredId(n);
}

export function isSubmissionId(n: number): n is SubmissionId {
  return isStoredId(n);
}

export function isConversationId(n: number): n is ConversationId {
  return isStoredId(n);
}
