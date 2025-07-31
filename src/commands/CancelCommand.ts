import { Command } from './BaseCommand.js'
import { cancelDeployment } from '../deployment.js'

export class CancelCommand extends Command<void> {
  public static commandRegex = /^cancel( deploy(ment)?)?$/
  public static commandDescription =
    '`cancel` - Cancel a running or queued deployment'

  public async handle(): Promise<void> {
    const cancelled = cancelDeployment(
      this.slackCommand.payload.channel,
      this.slackCommand.payload.user
    )

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
