/**
 * Minimal Telegram Bot API client for the edge review adapter.
 *
 * Two rules this file exists to enforce:
 *
 *  - **JSON only.** The Worker never downloads or uploads media. Approving a review
 *    uses Telegram's server-side `copyMessage`/`copyMessages`, so no image bytes
 *    ever pass through a 128 MB Worker or over its bandwidth.
 *  - **Per-bot isolation.** Each bot has its own token and its own client; a bot1
 *    callback can never be executed with a bot2 token.
 *
 * `fetch` is called through a wrapper because Workers reject a detached reference
 * ("Illegal invocation: function called with incorrect `this` reference") — a
 * runtime-only failure that a stored `this.fetch` reproduces.
 */

const API_BASE = 'https://api.telegram.org';
const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export interface TelegramResult {
  ok: boolean;
  /** Telegram's own error description, when it reports one. */
  description?: string;
  /**
   * Telegram's `result`, whose shape depends on the method.
   *
   * `copyMessage` answers with one MessageId object, `copyMessages` answers with a bare
   * ARRAY of them, and `getMe` answers with a User. Typing this as an object made the
   * array case unrepresentable, which is exactly how an album approval silently
   * recorded no published message id.
   */
  result?: unknown;
}

export interface BotApiClient {
  readonly botId: string;
  /**
   * Who this token belongs to. The cutover gate needs to prove the Worker holds a
   * USABLE token for each bot before the webhook moves, and "a secret is set" is not
   * the same as "Telegram accepts it".
   */
  getMe(): Promise<TelegramResult>;
  /** Human-visible acknowledgement of a button press. */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<TelegramResult>;
  /** Server-side copy of ONE review message into the channel. */
  copyMessage(input: {
    fromChatId: string;
    messageId: number;
    toChatId: string;
    messageThreadId?: number;
    caption?: string;
  }): Promise<TelegramResult>;
  /** Server-side copy of a media group (album) into the channel. */
  copyMessages(input: {
    fromChatId: string;
    messageIds: number[];
    toChatId: string;
    messageThreadId?: number;
  }): Promise<TelegramResult>;
  /** Remove the inline keyboard so a decided review cannot be pressed again. */
  editMessageReplyMarkup(input: { chatId: string; messageId: number }): Promise<TelegramResult>;
  /**
   * Replace the control card's text (and, in the same call, its keyboard).
   *
   * A decision has to be visible where the decision was made: the operator pressed a
   * button on a card, so the card is where the outcome belongs — including where the
   * post ended up.
   */
  editMessageText(input: {
    chatId: string;
    messageId: number;
    text: string;
    removeKeyboard?: boolean;
  }): Promise<TelegramResult>;
  sendMessage(input: { chatId: string; text: string; replyToMessageId?: number }): Promise<TelegramResult>;
}

interface TelegramEnvelope {
  ok?: boolean;
  description?: string;
  result?: unknown;
}

export class TelegramBotApi implements BotApiClient {
  constructor(
    readonly botId: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = defaultFetch,
    private readonly apiBase: string = API_BASE
  ) {}

  private async call(method: string, payload: Record<string, unknown>): Promise<TelegramResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      // Network-level failure: we do NOT know whether Telegram applied the call.
      // Callers must treat this as ambiguous rather than retrying blindly.
      return { ok: false, description: `network error: ${error instanceof Error ? error.message : String(error)}` };
    }

    let envelope: TelegramEnvelope = {};
    try {
      envelope = (await response.json()) as TelegramEnvelope;
    } catch {
      envelope = {};
    }
    if (!response.ok || envelope.ok === false) {
      // The error text is Telegram's; the token is never included in it.
      return {
        ok: false,
        ...(envelope.description ? { description: envelope.description } : { description: `HTTP ${response.status}` }),
      };
    }
    return {
      ok: true,
      ...(envelope.result && typeof envelope.result === 'object'
        ? { result: envelope.result as Record<string, unknown> }
        : {}),
    };
  }

  /** Proves the token works, and names the bot it belongs to. */
  getMe(): Promise<TelegramResult> {
    return this.call('getMe', {});
  }

  editMessageText(input: {
    chatId: string;
    messageId: number;
    text: string;
    removeKeyboard?: boolean;
  }): Promise<TelegramResult> {
    return this.call('editMessageText', {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
      ...(input.removeKeyboard === false ? {} : { reply_markup: { inline_keyboard: [] } }),
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<TelegramResult> {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  copyMessage(input: {
    fromChatId: string;
    messageId: number;
    toChatId: string;
    messageThreadId?: number;
    caption?: string;
  }): Promise<TelegramResult> {
    return this.call('copyMessage', {
      from_chat_id: input.fromChatId,
      message_id: input.messageId,
      chat_id: input.toChatId,
      ...(input.messageThreadId !== undefined ? { message_thread_id: input.messageThreadId } : {}),
      ...(input.caption ? { caption: input.caption } : {}),
    });
  }

  copyMessages(input: {
    fromChatId: string;
    messageIds: number[];
    toChatId: string;
    messageThreadId?: number;
  }): Promise<TelegramResult> {
    return this.call('copyMessages', {
      from_chat_id: input.fromChatId,
      message_ids: input.messageIds,
      chat_id: input.toChatId,
      ...(input.messageThreadId !== undefined ? { message_thread_id: input.messageThreadId } : {}),
    });
  }

  editMessageReplyMarkup(input: { chatId: string; messageId: number }): Promise<TelegramResult> {
    return this.call('editMessageReplyMarkup', {
      chat_id: input.chatId,
      message_id: input.messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  sendMessage(input: { chatId: string; text: string; replyToMessageId?: number }): Promise<TelegramResult> {
    return this.call('sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      ...(input.replyToMessageId !== undefined
        ? { reply_to_message_id: input.replyToMessageId, allow_sending_without_reply: true }
        : {}),
    });
  }
}

/** Registry that keeps bot tokens apart (bot1 callbacks never use bot2's token). */
export class BotRegistry {
  private readonly clients = new Map<string, BotApiClient>();

  constructor(
    tokens: Record<string, string | undefined>,
    private readonly factory: (botId: string, token: string) => BotApiClient = (botId, token) =>
      new TelegramBotApi(botId, token)
  ) {
    for (const [botId, token] of Object.entries(tokens)) {
      if (token && token.length > 0) this.clients.set(botId, factory(botId, token));
    }
  }

  get(botId: string): BotApiClient | null {
    return this.clients.get(botId) ?? null;
  }

  has(botId: string): boolean {
    return this.clients.has(botId);
  }
}
