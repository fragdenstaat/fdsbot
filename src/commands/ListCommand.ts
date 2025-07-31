import { Command } from './BaseCommand.js'
import { getDeployment } from '../deployment.js'

export class ListCommand extends Command<void> {
  public static commandRegex = /^list( deployments)?$/
  public static commandDescription =
    '`list` - List all running or queued deployments'

  public async handle(): Promise<void> {
    const deployment = getDeployment(this.slackCommand.payload.channel)

    if (deployment && !deployment.safeToClear()) {
      return await this.sendMessage(
        deployment.state === 'queued'
          ? 'Deployment queued'
          : 'Deployment running',
        `Deployment for \`${deployment.tag}\` by <@${deployment.user}> created at ${deployment.createdAt.toLocaleString()} is currently ${deployment.state}.`
      )
    }

    return await this.sendMessage(
      'No deployments',
      'There are currently no running or queued deployments.'
    )
  }
}
