import type { ConversationMessage } from "@/lib/types";

export const CONTEXT_COMPRESSION_TAIL_MESSAGES = 10;
export const CONTEXT_COMPRESSION_BATCH_SIZE = 10;
export const CONTEXT_COMPRESSION_SUMMARY_MAX_TOKENS = 400;

const SUMMARY_MESSAGE_PREFIX = "Conversation summary of earlier turns:\n";
const SUMMARY_INPUT_MESSAGE_LIMIT = 1200;
const SUMMARY_CHARACTER_LIMIT = 2400;
const SUMMARY_SECTION_SEPARATOR = "\n\n";
const MIN_TRUNCATED_SECTION_LENGTH = 240;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function formatMessageForSummaryPrompt(message: ConversationMessage) {
  const role = message.role === "user" ? "User" : "Assistant";
  const content = truncateText(message.content, SUMMARY_INPUT_MESSAGE_LIMIT);

  if (!content) {
    return "";
  }

  return `${role}: ${content}`;
}

export function formatConversationSummary(summary: string) {
  return `${SUMMARY_MESSAGE_PREFIX}${summary}`;
}

export function buildConversationSummaryPrompt(
  previousSummary: string | null | undefined,
  messages: ConversationMessage[]
) {
  const transcript = messages.map(formatMessageForSummaryPrompt).filter(Boolean).join("\n");
  const existingSummary = normalizeWhitespace(previousSummary ?? "");

  return [
    "You maintain a compact working memory summary for an assistant conversation.",
    "Update the summary using the new conversation chunk.",
    "Preserve factual details, user preferences, constraints, decisions, unresolved tasks, and commitments.",
    "Do not invent information that is not present in the summary or transcript.",
    "Keep the result concise but complete enough to restore context later.",
    "Return plain text only. Do not use JSON, XML, markdown headings, or code fences.",
    existingSummary ? `Existing summary:\n${existingSummary}` : "Existing summary:\n(none)",
    transcript ? `New conversation chunk:\n${transcript}` : "New conversation chunk:\n(none)",
    "Write the updated summary now."
  ].join("\n\n");
}

export function buildConversationSummary(
  previousSummary: string | null | undefined,
  messages: ConversationMessage[]
) {
  const existingSummary = normalizeWhitespace(previousSummary ?? "");
  const transcript = messages.map(formatMessageForSummaryPrompt).filter(Boolean).join("\n");

  if (!existingSummary && !transcript) {
    return null;
  }

  if (!existingSummary) {
    return truncateText(transcript, SUMMARY_CHARACTER_LIMIT);
  }

  if (!transcript) {
    return truncateText(existingSummary, SUMMARY_CHARACTER_LIMIT);
  }

  const combined = [existingSummary, transcript].filter(Boolean).join(SUMMARY_SECTION_SEPARATOR);
  if (combined.length <= SUMMARY_CHARACTER_LIMIT) {
    return combined;
  }

  const previousBudget = Math.max(
    MIN_TRUNCATED_SECTION_LENGTH,
    Math.floor(SUMMARY_CHARACTER_LIMIT * 0.55)
  );
  const nextBudget = Math.max(
    MIN_TRUNCATED_SECTION_LENGTH,
    SUMMARY_CHARACTER_LIMIT - previousBudget - SUMMARY_SECTION_SEPARATOR.length
  );

  return [
    truncateText(existingSummary, previousBudget),
    truncateText(transcript, nextBudget)
  ]
    .filter(Boolean)
    .join(SUMMARY_SECTION_SEPARATOR);
}

export function shouldPersistConversationSummary(
  hasStoredSummary: boolean,
  compressibleMessageCount: number,
  batchSize = CONTEXT_COMPRESSION_BATCH_SIZE
) {
  if (compressibleMessageCount <= 0) {
    return false;
  }

  if (!hasStoredSummary) {
    return true;
  }

  return compressibleMessageCount >= batchSize;
}

export function normalizeModelSummary(summary: string) {
  const normalized = summary.replace(/^Updated summary:\s*/i, "").trim();
  return normalized || null;
}
