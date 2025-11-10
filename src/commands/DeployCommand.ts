import type { MessageAttachment } from '@slack/types'
import { Command } from './BaseCommand.js'
import {
  clearDeployment,
  createDeployment,
  DeploymentProcess,
  DeploymentState,
  DeploymentTag,
  FINAL_STATES,
  AnsibleError,
  tagSchema,
  canCreateDeployment
} from '../deployment.js'
import { isSuperUser } from '../auth.js'

type ParsedDeployCommand = {
  command: 'deploy' | 'force deploy'
  tag: DeploymentTag
  args: Map<string, string>
}
class DeployCommand extends Command<ParsedDeployCommand> {
  public static commandRegex =
    /^(force deploy|deploy) (web|frontend|backend|all)(.*)$/
  public static commandDescription =
    '`(force) deploy [web|frontend|backend|all] [args]` - Deploy the specified tag'
  public allowedUserArgs: string[] = []

  private slackReaction?: string
  private deployment?: DeploymentProcess
  private stateListener = this.watchState.bind(this)

  public parseCommand(message: string) {
    const commandMatch = DeployCommand.commandRegex.exec(message)
    if (!commandMatch) {
      throw new Error('Could not parse command')
    }

    const command = commandMatch[1] as 'deploy' | 'force deploy'
    const tag = tagSchema.parse(commandMatch[2])

    const args = new Map<string, string>()
    const argsString = commandMatch[3].trim()

    const argumentRegex = /(\w+)=(".*?"|[^ ]+)/g
    let match

    while ((match = argumentRegex.exec(argsString)) !== null) {
      const key = match[1]
      const value = match[2].replace(/(^"|"$)/g, '') // Remove surrounding quotes if present

      if (args.has(key)) {
        throw new Error(`Duplicate argument: ${key}`)
      }

      if (!this.allowedUserArgs.includes(key)) {
        throw new Error(`Argument not allowed: ${key}`)
      }

      args.set(key, value)
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

  private async watchState(state: DeploymentState) {
    const stateMap: Record<string, string> = {
      done: 'white_check_mark',
      error: 'x',
      aborted: 'x'
    }

    if (FINAL_STATES.includes(state)) {
      this.deployment!.off('state', this.stateListener)
    }

    if (state === 'aborted') {
      await this.sendError(
        'Deployment aborted',
        'The deployment was cancelled.'
      )
    }

    if (stateMap[state]) {
      await this.setEmojiReaction(stateMap[state])
    }
  }

  public async handle(parsed: ParsedDeployCommand): Promise<void> {
    if (!canCreateDeployment(this.slackCommand.payload.channel)) {
      return await this.sendError(
        'Deployment already running',
        'There is already a deployment running in this channel.'
      )
    }

    const { command, tag } = parsed
    const user = this.slackCommand.payload.user!
    this.deployment = createDeployment(
      this.slackCommand.payload.channel,
      user,
      tag,
      this.ansibleArgs(parsed)
    )

    this.deployment.on('state', this.stateListener)

    await this.setEmojiReaction('hourglass_flowing_sand')

    const cancelButton: MessageAttachment = {
      blocks: [
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              action_id: 'cancel_deployment',
              text: {
                type: 'plain_text',
                text: 'Cancel deployment'
              },
              style: 'danger',
              value: this.slackCommand.payload.channel
            }
          ]
        }
      ]
    }

    if (command === 'force deploy') {
      if (!isSuperUser(user)) {
        clearDeployment(this.slackCommand.payload.channel)
        return await this.sendError(
          'You are not allowed to force deploy.',
          'Please contact a superuser.'
        )
      } else {
        await this.sendMessage(
          'Deployment started',
          'Skipping checks. This better be good.',
          undefined,
          [cancelButton]
        )
      }
    } else {
      await this.sendMessage(
        'Deployment started',
        `Deployment of ${tag} queued by <@${user}>.`,
        undefined,
        [cancelButton]
      )

      try {
        const success = await this.runChecks()
        if (!success) return
      } catch (error) {
        console.error('Error collecting checks:', error)
        return await this.sendError(
          'Unknown error collecting checks',
          'Please contact an administrator.'
        )
      }
    }

    this.deployment.on('progress', async (message) => {
      await this.sendMessage(message)
    })

    try {
      await this.deployment.updateRepo()

      await this.sendMessage('Running Ansible playbook…')
      const success = await this.deployment.runPlaybook()

      if (success)
        await this.sendMessage(
          'Success!',
          `Deployment of ${tag} completed successfully!`,
          '#36a64f'
        )
      else if (this.deployment.out) {
        await this.uploadLog(this.deployment.out)
      }
    } catch (error) {
      clearDeployment(this.slackCommand.payload.channel)

      if (error instanceof AnsibleError) {
        console.log('Ansible error:', error.stdout, error.stderr)

        await this.sendError('Deployment failed', error.message)
        await this.uploadLog(error.out)
        return
      }

      return this.sendError('Unexpected error', (error as Error).message)
    }
  }

  protected async runChecks(): Promise<boolean> {
    const checks = await this.deployment!.runChecks(() => {
      this.sendMessage(
        'Checks are pending. Deployment will continue once checks are completed.'
      )
    })

    if (checks === true) {
      await this.sendMessage(
        'All checks have passed, proceeding with deployment.'
      )
      return true
    } else if (checks === false) {
      // checking was aborted
      return false
    } else {
      clearDeployment(this.slackCommand.payload.channel)

      const checksMarkup = checks
        .map((f) => `<${f.url}|${f.repo}: ${f.name}>`)
        .join(', ')

      await this.sendError(
        'Checks have failed, aborted deployment.',
        checksMarkup
      )
      return false
    }
  }

  private async uploadLog(content: string) {
    await this.slackCommand.client.filesUploadV2({
      thread_ts: this.slackCommand.payload.ts,
      channel_id: this.slackCommand.payload.channel,
      content,
      filename: 'error.txt'
    })
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
  public allowedUserArgs = ['fragdenstaat_de']

  protected async runChecks() {
    // in test environment, we don't run checks
    return true
  }

  ansibleArgs({ args: userArgs }: ReturnType<this['parseCommand']>): string[] {
    const args = ['-i', 'test-inventory']

    if (userArgs.has('fragdenstaat_de')) {
      args.push(
        '-e',
        JSON.stringify({ git_branch: userArgs.get('fragdenstaat_de') })
      )
    }

    return args
  }
}
