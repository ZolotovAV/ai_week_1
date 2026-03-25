import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ConversationMessage } from "@/lib/types";

const DATA_DIRECTORY = path.join(process.cwd(), "data");
const DATABASE_PATH = path.join(DATA_DIRECTORY, "agent-context.sqlite");

type DatabaseState = {
  db: DatabaseSync;
};

type ConversationRow = {
  id: string;
};

type MessageRow = {
  content: string;
  role: ConversationMessage["role"];
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

function readConversationMessages(
  db: DatabaseSync,
  conversationId: string
): ConversationMessage[] {
  requireConversation(db, conversationId);

  const statement = db.prepare(`
    SELECT role, content
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC;
  `);

  const rows = statement.all(conversationId) as MessageRow[];

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
