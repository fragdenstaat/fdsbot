import { Command, type SlackCommand } from './BaseCommand.js'

export function routeCommands(
  commands: Record<string, (typeof Command<any>)[]>
): (slackCommand: SlackCommand) => Promise<void> {
  return async (slackCommand) => {
    const message = slackCommand.payload.text
      .replace(`<@${slackCommand.context.botUserId}>`, '')
      .trim()
    const availableCommands = commands[slackCommand.payload.channel]

    if (!availableCommands) {
      console.error(
        `Found no commands for channel ${slackCommand.payload.channel} - is the auth middleware working correctly?`
      )
      await slackCommand.say({
        text: "I don't work in this channel."
      })
      return
    }

    const Command = availableCommands.find((c) => c.commandRegex.test(message))

    if (!Command) {
      let text = ''

      if (message !== 'help') text += 'Command not found. '
      text += 'Available commands:\n\n'
      text += availableCommands
        .map((c) => `- ${c.commandDescription}`)
        .join('\n')

      await slackCommand.say({
        mrkdwn: true,
        text,
        thread_ts: slackCommand.payload.ts
      })
      return
    }

    try {
      new Command(slackCommand).run(message)
    } catch (error) {
      console.error('Error processing command:', error)
      await slackCommand.say({
        text: 'Unknown error processing command. Please contact an administrator.'
      })
    }
  }
}

export { ProductionDeployCommand, TestDeployCommand } from './DeployCommand.js'
export { CancelCommand } from './CancelCommand.js'
export { ListCommand } from './ListCommand.js'
