import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  buildConversationSummary,
  CONTEXT_COMPRESSION_BATCH_SIZE,
  CONTEXT_COMPRESSION_TAIL_MESSAGES,
  formatConversationSummary,
  shouldPersistConversationSummary
} from "@/lib/context-compression";
import { estimateMessageTokensForRole } from "@/lib/token-usage";
import type {
  CompressedConversationContext,
  ConversationMessage,
  ConversationSummary
} from "@/lib/types";

const DATA_DIRECTORY = path.join(process.cwd(), "data");
const DATABASE_PATH = path.join(DATA_DIRECTORY, "agent-context.sqlite");

type DatabaseState = {
  db: DatabaseSync;
};

type ConversationRow = {
  id: string;
};

type MessageRow = {
  id: number;
  content: string;
  role: ConversationMessage["role"];
};

type SummaryRow = {
  covered_message_count: number;
  covered_message_id: number;
  summary: string;
  updated_at: string;
};

type SummaryRefreshCandidate = {
  coveredMessageCount: number;
  coveredMessageId: number;
  messages: ConversationMessage[];
  previousSummary: string | null;
};

export class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Conversation "${conversationId}" was not found.`);
    this.name = "ConversationNotFoundError";
  }
}

let databaseStatePromise: Promise<DatabaseState> | null = null;
let writeQueue = Promise.resolve();

function getTimestamp() {
  return new Date().toISOString();
}

function initializeSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      covered_message_id INTEGER NOT NULL,
      covered_message_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
      ON messages (conversation_id, id);
  `);
}

async function initializeDatabase(): Promise<DatabaseState> {
  await mkdir(DATA_DIRECTORY, { recursive: true });

  const db = new DatabaseSync(DATABASE_PATH, {
    enableForeignKeyConstraints: true
  });

  initializeSchema(db);

  return { db };
}

async function getDatabaseState() {
  if (!databaseStatePromise) {
    databaseStatePromise = initializeDatabase();
  }

  return databaseStatePromise;
}

async function runWrite<T>(operation: (state: DatabaseState) => T | Promise<T>) {
  const nextOperation = writeQueue.then(async () => {
    const state = await getDatabaseState();
    return operation(state);
  });

  writeQueue = nextOperation.then(
    () => undefined,
    () => undefined
  );

  return nextOperation;
}

function getConversationRow(db: DatabaseSync, conversationId: string): ConversationRow | null {
  const statement = db.prepare("SELECT id FROM conversations WHERE id = ? LIMIT 1;");
  const row = statement.get(conversationId) as ConversationRow | undefined;

  return row ?? null;
}

function requireConversation(db: DatabaseSync, conversationId: string) {
  const row = getConversationRow(db, conversationId);

  if (!row) {
    throw new ConversationNotFoundError(conversationId);
  }
}

function mapMessageRows(rows: MessageRow[]): ConversationMessage[] {
  return rows.flatMap((row) => {
    if ((row.role === "user" || row.role === "assistant") && typeof row.content === "string") {
      return [
        {
          role: row.role,
          content: row.content
        }
      ];
    }

    return [];
  });
}

function readConversationMessages(db: DatabaseSync, conversationId: string): ConversationMessage[] {
  requireConversation(db, conversationId);

  const statement = db.prepare(`
    SELECT id, role, content
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC;
  `);

  const rows = statement.all(conversationId) as MessageRow[];
  return mapMessageRows(rows);
}

function readConversationSummary(
  db: DatabaseSync,
  conversationId: string
): ConversationSummary | null {
  requireConversation(db, conversationId);

  const statement = db.prepare(`
    SELECT summary, covered_message_id, covered_message_count, updated_at
    FROM conversation_summaries
    WHERE conversation_id = ?
    LIMIT 1;
  `);
  const row = statement.get(conversationId) as SummaryRow | undefined;

  if (!row) {
    return null;
  }

  return {
    summary: row.summary,
    coveredMessageCount: row.covered_message_count,
    coveredMessageId: row.covered_message_id,
    updatedAt: row.updated_at
  };
}

function readTailMessageRows(db: DatabaseSync, conversationId: string, limit: number) {
  requireConversation(db, conversationId);

  if (limit <= 0) {
    return [] as MessageRow[];
  }

  const statement = db.prepare(`
    SELECT id, role, content
    FROM (
      SELECT id, role, content
      FROM messages
      WHERE conversation_id = ?
      ORDER BY id DESC
      LIMIT ?
    )
    ORDER BY id ASC;
  `);

  return statement.all(conversationId, limit) as MessageRow[];
}

function readMessageRowsBeforeTail(
  db: DatabaseSync,
  conversationId: string,
  coveredMessageId: number,
  earliestTailMessageId: number | null
) {
  requireConversation(db, conversationId);

  if (earliestTailMessageId === null) {
    return [] as MessageRow[];
  }

  const statement = db.prepare(`
    SELECT id, role, content
    FROM messages
    WHERE conversation_id = ?
      AND id > ?
      AND id < ?
    ORDER BY id ASC;
  `);

  return statement.all(conversationId, coveredMessageId, earliestTailMessageId) as MessageRow[];
}

function upsertConversationSummary(
  db: DatabaseSync,
  conversationId: string,
  summary: string,
  coveredMessageId: number,
  coveredMessageCount: number
) {
  const timestamp = getTimestamp();

  db.prepare(
    `
      INSERT INTO conversation_summaries (
        conversation_id,
        summary,
        covered_message_id,
        covered_message_count,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        summary = excluded.summary,
        covered_message_id = excluded.covered_message_id,
        covered_message_count = excluded.covered_message_count,
        updated_at = excluded.updated_at;
    `
  ).run(conversationId, summary, coveredMessageId, coveredMessageCount, timestamp);
}

function buildSummaryRefreshCandidate(
  db: DatabaseSync,
  conversationId: string,
  tailSize: number,
  batchSize: number
): SummaryRefreshCandidate | null {
  const storedSummary = readConversationSummary(db, conversationId);
  const tailRows = readTailMessageRows(db, conversationId, tailSize);
  const earliestTailMessageId = tailRows[0]?.id ?? null;
  const pendingRows = readMessageRowsBeforeTail(
    db,
    conversationId,
    storedSummary?.coveredMessageId ?? 0,
    earliestTailMessageId
  );

  if (pendingRows.length === 0) {
    return null;
  }

  if (
    !shouldPersistConversationSummary(Boolean(storedSummary), pendingRows.length, batchSize)
  ) {
    return null;
  }

  const lastCoveredRow = pendingRows[pendingRows.length - 1];
  if (!lastCoveredRow) {
    return null;
  }

  return {
    coveredMessageCount: (storedSummary?.coveredMessageCount ?? 0) + pendingRows.length,
    coveredMessageId: lastCoveredRow.id,
    messages: mapMessageRows(pendingRows),
    previousSummary: storedSummary?.summary ?? null
  };
}

function buildCompressedContext(
  db: DatabaseSync,
  conversationId: string,
  tailSize: number
): CompressedConversationContext {
  const storedSummary = readConversationSummary(db, conversationId);
  const tailRows = readTailMessageRows(db, conversationId, tailSize);
  const earliestTailMessageId = tailRows[0]?.id ?? null;
  const pendingRows = readMessageRowsBeforeTail(
    db,
    conversationId,
    storedSummary?.coveredMessageId ?? 0,
    earliestTailMessageId
  );
  const pendingMessages = mapMessageRows(pendingRows);
  const tailMessages = mapMessageRows(tailRows);
  const compressedMessages = (storedSummary?.coveredMessageCount ?? 0) + pendingMessages.length;
  const effectiveSummary = buildConversationSummary(storedSummary?.summary, pendingMessages);

  return {
    effectiveSummary,
    summary: storedSummary,
    tailMessages,
    contextCompression: {
      enabled: true,
      summaryPresent: Boolean(effectiveSummary),
      retainedMessages: tailMessages.length,
      compressedMessages,
      coveredMessageCount: compressedMessages,
      summaryEstimatedTokens: effectiveSummary
        ? estimateMessageTokensForRole("assistant", formatConversationSummary(effectiveSummary))
        : 0
    }
  };
}

export const conversationStore = {
  async createConversation() {
    return runWrite((state) => {
      const timestamp = getTimestamp();
      const conversationId = randomUUID();

      state.db
        .prepare(
          `
            INSERT INTO conversations (id, created_at, updated_at)
            VALUES (?, ?, ?);
          `
        )
        .run(conversationId, timestamp, timestamp);

      return { conversationId };
    });
  },

  async conversationExists(conversationId: string) {
    const state = await getDatabaseState();
    return getConversationRow(state.db, conversationId) !== null;
  },

  async getConversationMessages(conversationId: string) {
    const state = await getDatabaseState();
    return readConversationMessages(state.db, conversationId);
  },

  async getCompressedContext(
    conversationId: string,
    tailSize = CONTEXT_COMPRESSION_TAIL_MESSAGES
  ) {
    const state = await getDatabaseState();
    return buildCompressedContext(state.db, conversationId, tailSize);
  },

  async getSummaryRefreshCandidate(
    conversationId: string,
    tailSize = CONTEXT_COMPRESSION_TAIL_MESSAGES,
    batchSize = CONTEXT_COMPRESSION_BATCH_SIZE
  ) {
    const state = await getDatabaseState();
    requireConversation(state.db, conversationId);
    return buildSummaryRefreshCandidate(state.db, conversationId, tailSize, batchSize);
  },

  async saveConversationSummary(
    conversationId: string,
    summary: string,
    coveredMessageId: number,
    coveredMessageCount: number
  ) {
    return runWrite((state) => {
      requireConversation(state.db, conversationId);
      upsertConversationSummary(
        state.db,
        conversationId,
        summary,
        coveredMessageId,
        coveredMessageCount
      );
      return buildCompressedContext(state.db, conversationId, CONTEXT_COMPRESSION_TAIL_MESSAGES);
    });
  },

  async appendMessage(conversationId: string, role: ConversationMessage["role"], content: string) {
    return runWrite((state) => {
      requireConversation(state.db, conversationId);

      const timestamp = getTimestamp();

      state.db
        .prepare(
          `
            INSERT INTO messages (conversation_id, role, content, created_at)
            VALUES (?, ?, ?, ?);
          `
        )
        .run(conversationId, role, content, timestamp);

      state.db
        .prepare(
          `
            UPDATE conversations
            SET updated_at = ?
            WHERE id = ?;
          `
        )
        .run(timestamp, conversationId);
    });
  },

  async deleteConversation(conversationId: string) {
    return runWrite((state) => {
      state.db.prepare("DELETE FROM messages WHERE conversation_id = ?;").run(conversationId);
      state.db.prepare("DELETE FROM conversations WHERE id = ?;").run(conversationId);
    });
  },

  async close() {
    const state = await getDatabaseState();
    state.db.close();
    databaseStatePromise = null;
  }
};
