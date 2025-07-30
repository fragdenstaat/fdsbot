import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from '@slack/bolt'
import {
  cancelAllDeployments,
  clearDeployment,
  createDeployment,
  DeploymentProcess,
  DeploymentState,
  DeploymentTag,
  FINAL_STATES,
  getAllDeployments,
  AnsibleError,
  tagSchema
} from './deployment.js'
import { CheckError } from './github.js'
import { isSuperUser } from './auth.js'

type SlackCommand = SlackEventMiddlewareArgs<'app_mention'> & AllMiddlewareArgs
class Command<ParsedCommand> {
  public static commandRegex: RegExp
  public static commandDescription: string

  constructor(protected slackCommand: SlackCommand) {}

  protected async sendMessage(
    title: string,
    text?: string,
    color?: string
  ): Promise<void> {
    if (!text) {
      await this.slackCommand.say({
        thread_ts: this.slackCommand.payload.ts,
        text: title,
        mrkdwn: true
      })
    } else {
      await this.slackCommand.say({
        thread_ts: this.slackCommand.payload.ts,
        text: `*${title}*`,
        mrkdwn: true,
        attachments: [
          {
            text,
            mrkdwn_in: ['text'],
            color
          }
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

type ParsedDeployCommand = {
  command: 'deploy' | 'force deploy'
  tag: DeploymentTag
  args: Record<string, string>
}
class DeployCommand extends Command<ParsedDeployCommand> {
  public static commandRegex =
    /^(force deploy|deploy) (web|frontend|backend|all)(.*)$/
  public static commandDescription =
    '`(force) deploy [web|frontend|backend|all] [args]` - Deploy the specified tag'
  public allowedUserArgs: string[] = []
  protected env: 'production' | 'test' = 'production'

  private slackReaction?: string
  private deployment?: DeploymentProcess
  private stateListener = this.updateEmojiReaction.bind(this)

  public parseCommand(message: string) {
    const commandMatch = DeployCommand.commandRegex.exec(message)
    if (!commandMatch) {
      throw new Error('Could not parse command')
    }

    const command = commandMatch[1] as 'deploy' | 'force deploy'
    const tag = tagSchema.parse(commandMatch[2])

    const args: Record<string, string> = {}
    const argsString = commandMatch[3].trim()

    const argumentRegex = /(\w+)=(".*?"|[^ ]+)/g
    let match

    while ((match = argumentRegex.exec(argsString)) !== null) {
      const key = match[1]
      const value = match[2].replace(/(^"|"$)/g, '') // Remove surrounding quotes if present

      if (key in args) {
        throw new Error(`Duplicate argument: ${key}`)
      }

      if (!this.allowedUserArgs.includes(key)) {
        throw new Error(`Argument not allowed: ${key}`)
      }

      args[key] = value
    }

    return { command, tag, args }
  }

  public ansibleArgs(_command: ParsedDeployCommand): string[] {
    return []
  }

  private async setEmojiReaction(name: string) {
    const { channel, ts: timestamp } = this.slackCommand.payload

    if (this.slackReaction) {
      await this.slackCommand.client.reactions.remove({
        name: this.slackReaction,
        channel,
        timestamp
      })
    }
    this.slackReaction = name

    await this.slackCommand.client.reactions.add({
      name,
      channel,
      timestamp
    })
  }

  private async updateEmojiReaction(state: DeploymentState) {
    const stateMap: Record<string, string> = {
      done: 'white_check_mark',
      error: 'x',
      aborted: 'x'
    }

    if (FINAL_STATES.includes(state)) {
      this.deployment!.off('state', this.stateListener)
    }

    if (stateMap[state]) {
      await this.setEmojiReaction(stateMap[state])
    }
  }

  public async handle(parsed: ParsedDeployCommand): Promise<void> {
    const { command, tag } = parsed
    const user = this.slackCommand.payload.user!
    this.deployment = createDeployment(
      this.env,
      user,
      tag,
      this.ansibleArgs(parsed)
    )

    this.deployment.on('state', this.stateListener)

    await this.setEmojiReaction('hourglass_flowing_sand')

    if (command === 'force deploy') {
      if (!isSuperUser(user)) {
        clearDeployment(this.env)
        return await this.sendError(
          'You are not allowed to force deploy.',
          'Please contact a superuser.'
        )
      } else {
        await this.sendMessage(
          'Deployment started',
          'Skipping checks. This better be good.'
        )
      }
    } else {
      await this.sendMessage(
        'Deployment started',
        `Deployment of ${tag} queued by <@${user}>.`
      )

      try {
        await this.deployment.runChecks(() => {
          this.sendMessage(
            'Checks are pending. Deployment will continue once checks are completed.'
          )
        })
        await this.sendMessage(
          'All checks have passed, proceeding with deployment.'
        )
      } catch (error) {
        clearDeployment(this.env)

        if (error instanceof CheckError) {
          const { failedChecks } = error

          const checksMarkup = failedChecks
            .map((f) => `<${f.url}|${f.repo}: ${f.name}>`)
            .join(', ')

          return await this.sendError(
            'Checks have failed, aborted deployment.',
            checksMarkup
          )
        }

        console.error('Error collecting checks:', error)

        return await this.sendError(
          'Unknown error collecting checks',
          'Please contact an administrator.'
        )
      }
    }

    this.deployment.on('progress', async (message) => {
      await this.sendMessage(`Deployment progress: ${message}`)
    })

    try {
      await this.deployment.updateRepo()

      await this.sendMessage('Running Ansible playbook…')
      await this.deployment.runPlaybook()

      await this.sendMessage(
        'Success!',
        `Deployment of ${tag} completed successfully!`,
        '#36a64f'
      )
    } catch (error) {
      clearDeployment(this.env)

      if (error instanceof AnsibleError) {
        console.log('Ansible error:', error.stdout, error.stderr)
        return this.sendError(error.message, error.stderr || error.stdout || '')
      }

      return this.sendError('Unexpected error', (error as Error).message)
    }
  }

  public async run(message: string) {
    if ((await super.run(message)) === false) {
      await this.setEmojiReaction('x')
    }
  }
}

export class ProductionDeployCommand extends DeployCommand {
  ansibleArgs(): string[] {
    return ['-i', 'inventory']
  }
}

export class TestDeployCommand extends DeployCommand {
  public allowedUserArgs = ['fragdenstaat_de', 'froide']
  protected env = 'test' as const

  ansibleArgs({ args: userArgs }: ReturnType<this['parseCommand']>): string[] {
    const args = ['-i', 'test-inventory']

    if (userArgs.fragdenstaat_de) {
      args.push('-e', JSON.stringify({ git_branch: userArgs.fragdenstaat_de }))
    }

    if (userArgs.froide) {
      args.push('-e', JSON.stringify({ froide_version: userArgs.froide }))
    }

    return args
  }
}

export class CancelCommand extends Command<void> {
  public static commandRegex = /^cancel deploy(ment)?$/
  public static commandDescription =
    '`cancel deploy` - Cancel a running or queued deployment'

  public async handle(): Promise<void> {
    const cancelled = cancelAllDeployments()

    if (cancelled) {
      return await this.sendMessage(
        'Deployment cancelled',
        'A deployment was running and has been cancelled.'
      )
    } else {
      return await this.sendMessage(
        'Nothing to cancel',
        'No deployment was queued or running.'
      )
    }
  }
}

export class ListCommand extends Command<void> {
  public static commandRegex = /^list( deployments)?$/
  public static commandDescription =
    '`list` - List all running or queued deployments'

  public async handle(): Promise<void> {
    const deployments = getAllDeployments()

    if (deployments.length === 0) {
      return await this.sendMessage(
        'No deployments',
        'There are currently no running or queued deployments.'
      )
    }

    return await this.sendMessage(
      'List of deployments',
      'No deployment was queued or running.'
    )
  }
}

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
