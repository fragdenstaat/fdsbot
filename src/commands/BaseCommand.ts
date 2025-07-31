import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from '@slack/bolt'
import type { MessageAttachment } from '@slack/types'

export type SlackCommand = SlackEventMiddlewareArgs<'app_mention'> &
  AllMiddlewareArgs
export class Command<ParsedCommand> {
  public static commandRegex: RegExp
  public static commandDescription: string

  constructor(protected slackCommand: SlackCommand) {}

  protected async sendMessage(
    title: string,
    text?: string,
    color?: string,
    attachments: MessageAttachment[] = []
  ): Promise<void> {
    if (!text) {
      await this.slackCommand.say({
        thread_ts: this.slackCommand.payload.ts,
        channel: this.slackCommand.payload.channel,
        text: title,
        mrkdwn: true,
        attachments
      })
    } else {
      await this.slackCommand.say({
        thread_ts: this.slackCommand.payload.ts,
        channel: this.slackCommand.payload.channel,
        text: `*${title}*`,
        mrkdwn: true,
        attachments: [
          {
            text,
            mrkdwn_in: ['text'],
            color
          },
          ...attachments
        ]
      })
    }
  }

  protected async sendError(title: string, text: string) {
    await this.sendMessage(title, text, '#900')
  }

  public parseCommand(_message: string): ParsedCommand {
    return {} as ParsedCommand
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public handle(parsed: ParsedCommand): Promise<void> {
    throw new Error('Command handler not implemented for this command')
  }

  public async run(message: string): Promise<false | void> {
    let parsedCommand: ParsedCommand

    try {
      parsedCommand = this.parseCommand(message)
    } catch (error) {
      await this.sendError('Invalid command', (error as Error).message)
      return false
    }

    return this.handle(parsedCommand)
  }
}
