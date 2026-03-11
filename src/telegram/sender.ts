import TelegramBot from 'node-telegram-bot-api';

export class TelegramSender {
  private chatId: string;
  private bot: TelegramBot;

  constructor(token: string, chatId: string) {
    this.chatId = chatId;
    this.bot = new TelegramBot(token, { polling: false });
  }

  async send(msg: string): Promise<void> {
    this.bot.sendMessage(this.chatId, msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  }
}
