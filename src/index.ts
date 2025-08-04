import Bolt from '@slack/bolt'
import {
  SLACK_ROOM_PROD,
  SLACK_ROOM_TEST,
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN
} from './conf.js'
import {
  actionAuthMiddleware,
  isAllowedUser,
  mentionAuthMiddleware
} from './auth.js'
import {
  CancelCommand,
  TestDeployCommand,
  ProductionDeployCommand,
  routeCommands,
  ListCommand
} from './commands/index.js'
import { cancelDeployment } from './deployment.js'

const app = new Bolt.App({
  signingSecret: SLACK_SIGNING_SECRET,
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true
})

app.event(
  'app_mention',
  mentionAuthMiddleware,
  routeCommands({
    [SLACK_ROOM_PROD]: [ProductionDeployCommand, CancelCommand, ListCommand],
    [SLACK_ROOM_TEST]: [TestDeployCommand, CancelCommand, ListCommand]
  })
)

app.action(
  'cancel_deployment',
  actionAuthMiddleware,
  async ({ ack, body, respond, say }) => {
    await ack()
    if (cancelDeployment(body.channel!.id!)) {
      await respond(`Deployment cancelled.`)
      await say({
        channel: body.channel!.id!,
        text: `A deployment was cancelled by <@${body.user.id}>.`
      })
    } else {
      await respond(
        `<@${body.user.id}> There are no queued or running deployments.`
      )
    }
  }
)

app.event('member_joined_channel', async ({ payload, client }) => {
  const text = isAllowedUser(payload.user)
    ? `Welcome <@${payload.user}>!`
    : `Welcome <@${payload.user}>! Please add them to the list of allowed users if they should be able to interact with me (\`${payload.user}\`).`

  await client.chat.postMessage({
    channel: payload.channel,
    text
  })
})

await app.start()
console.log('⚡️ Slack app is running!')
