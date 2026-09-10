import { createReview } from '../src/reviews';
import type { BotApiClient, TelegramResult } from '../src/telegram/client';
import { MemoryControlStore } from './memory-store';

export { MemoryControlStore };

export const NOW = Date.parse('2026-09-11T10:00:00Z');

export interface FakeBot extends BotApiClient {
  calls: Array<{ method: string; payload: unknown }>;
  /** Optional script: return a crafted Telegram result for one method. */
  script?: (method: string) => TelegramResult | undefined;
}

export function fakeBot(botId = 'bot1'): FakeBot {
  const calls: FakeBot['calls'] = [];
  // Explicitly typed: the object refers to itself through `record`, and inference
  // through that cycle would make `bot` implicitly any.
  const bot: FakeBot = {
    botId,
    calls,
    script: undefined as ((method: string) => TelegramResult | undefined) | undefined,
    getMe: async () => record('getMe', {}),
    answerCallbackQuery: async (id: string, text?: string) => record('answerCallbackQuery', { id, text }),
    copyMessage: async (input: Parameters<BotApiClient['copyMessage']>[0]) => record('copyMessage', input),
    // Telegram answers copyMessages with a bare ARRAY of MessageId objects; the fake
    // answering {message_id} is what hid a missing published id for album approvals.
    copyMessages: async (input: Parameters<BotApiClient['copyMessages']>[0]) => {
      calls.push({ method: 'copyMessages', payload: input });
      const scripted = bot.script?.('copyMessages');
      if (scripted) return scripted;
      return { ok: true, result: input.messageIds.map((messageId) => ({ message_id: 1000 + messageId })) };
    },
    editMessageReplyMarkup: async (input: Parameters<BotApiClient['editMessageReplyMarkup']>[0]) =>
      record('editMessageReplyMarkup', input),
    sendMessage: async (input: Parameters<BotApiClient['sendMessage']>[0]) => record('sendMessage', input),
  } satisfies FakeBot;

  function record(method: string, payload: unknown): TelegramResult {
    calls.push({ method, payload });
    const scripted = bot.script?.(method);
    return scripted ?? { ok: true, result: { message_id: 555 } };
  }

  return bot;
}

export async function seedReview(
  store: MemoryControlStore,
  overrides: Partial<Parameters<typeof createReview>[1]> = {},
  nowMs = NOW
) {
  return createReview(
    store,
    {
      id: 'rv1',
      botId: 'bot1',
      chatId: '-1004318193445',
      messageId: 42,
      publishChatId: '-100channel',
      targetId: 'bot1-illust-botefuku',
      workId: '29088506',
      slotId: 'bot1-daily@2026-09-11T1800',
      ...overrides,
    },
    nowMs
  );
}

