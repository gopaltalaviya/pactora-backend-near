import {ChannelError, redact, type ChannelProvider} from './channels.js';

/**
 * The Telegram Bot API (https://core.telegram.org/bots/api): long-polled
 * `getUpdates` in, `sendMessage` out. Written from the published API and
 * NOT verified against a live bot here: that needs the owner's bot token
 * (docs/26 §4). The token is in the URL Telegram requires, so every error
 * is redacted before it is thrown.
 */

export interface TelegramUpdate {
  updateId: number;
  chatId: string;
  text: string;
}

export class TelegramBot implements ChannelProvider {
  readonly channel = 'telegram' as const;
  private readonly base: string;
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    apiBase = 'https://api.telegram.org',
  ) {
    this.base = `${apiBase}/bot${token}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs = 35_000): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/${method}`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ChannelError(
        redact(`network: ${err instanceof Error ? err.message : String(err)}`, [this.token]),
        'retry',
      );
    }
    const json = (await res.json().catch(() => ({}))) as {ok?: boolean; result?: T; description?: string};
    if (res.ok && json.ok) return json.result as T;
    const msg = redact(json.description ?? `HTTP ${res.status}`, [this.token]);
    // 429 and 5xx come back; 400 (bad chat), 401 (bad token), 403 (blocked by the user) do not.
    throw new ChannelError(msg, res.status === 429 || res.status >= 500 ? 'retry' : 'permanent', res.status);
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.call('sendMessage', {chat_id: chatId, text, disable_web_page_preview: true});
  }

  /** Updates after `offset`; waits up to 25 s for one. */
  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const updates = await this.call<
      {update_id: number; message?: {chat?: {id?: number | string; type?: string}; text?: string}}[]
    >('getUpdates', {offset, timeout: 25, allowed_updates: ['message']});
    return updates
      .filter((u) => u.message?.chat?.id !== undefined && u.message.chat.type === 'private')
      .map((u) => ({
        updateId: u.update_id,
        chatId: String(u.message!.chat!.id),
        text: u.message!.text ?? '',
      }));
  }
}

/** Email behind the same outbox. Only a fake today: no provider is chosen (docs/26 §4, D5). */
export class FakeEmail implements ChannelProvider {
  readonly channel = 'email' as const;
  readonly sent: {to: string; body: string}[] = [];
  async send(to: string, body: string): Promise<void> {
    this.sent.push({to, body});
  }
}
