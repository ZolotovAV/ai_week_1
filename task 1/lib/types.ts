import { z } from "zod";

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(20000)
});

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1),
  systemPrompt: z.string().min(1).max(4000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(4096).optional(),
  reasoning: z
    .object({
      enabled: z.boolean(),
      effort: z.enum(["low", "medium", "high"]).optional()
    })
    .optional()
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
