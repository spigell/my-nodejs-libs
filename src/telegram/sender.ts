import { Bot } from 'node-telegram-bot-api';

export class TelegramSender {
  private chatId: string;
  private bot: Bot;

  constructor(token: string, chatId: string) {
    this.chatId = chatId;
    this.bot = new Bot(token);
  }

  async send(msg: string): Promise<void> {
    await this.bot.api.sendMessage({
      chat_id: this.chatId,
      text: msg,
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
  }
}
