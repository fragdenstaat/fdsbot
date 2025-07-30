import * as Sentry from '@sentry/node'
import Bolt from '@slack/bolt'
import {
  ALLOWED_USERS,
  SLACK_ROOM_PROD,
  SLACK_ROOM_TEST,
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  SENTRY_DSN
} from './conf.js'
import { isAllowedChannel, isAllowedUser } from './auth.js'
import {
  CancelCommand,
  TestDeployCommand,
  ProductionDeployCommand,
  routeCommands,
  ListCommand
} from './commands.js'
import { cancelAllDeployments } from './deployment.js'

if (SENTRY_DSN)
  Sentry.init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 1.0
  })

const app = new Bolt.App({
  signingSecret: SLACK_SIGNING_SECRET,
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true
})

app.use(async ({ payload, next, client }) => {
  // main auth middleware - check that user and channel are allowed
  const { channel, user } = payload as any

  if (payload.type === 'member_joined_channel') return await next()

  if (!isAllowedChannel(channel)) {
    await client.chat.postMessage({
      text: "I don't work in this channel.",
      channel
    })
    return
  }

  if (!isAllowedUser(user)) {
    await client.chat.postMessage({
      text: 'You are not allowed to use this command',
      channel,
      blocks: [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                {
                  type: 'text',
                  text: `You are not allowed to use this command. Please ask one of:`
                },
                ...ALLOWED_USERS.map((u) => ({
                  type: 'user' as const,
                  user_id: u
                }))
              ]
            }
          ]
        }
      ]
    })
    return
  }

  await next()
})

app.event(
  'app_mention',
  routeCommands({
    [SLACK_ROOM_PROD]: [ProductionDeployCommand, CancelCommand, ListCommand],
    [SLACK_ROOM_TEST]: [TestDeployCommand, CancelCommand, ListCommand]
  })
)

app.action(
  'cancel_deployment',
  async ({ ack, body, respond, action, client }) => {
    if (action.type === 'button') {
      await ack()
      if (cancelAllDeployments()) {
        await respond(`<@${body.user.id}> Deployment cancelled.`)
        await client.chat.postMessage({
          channel: body.channel!.id!,
          text: `A deployment was cancelled by <@${body.user.id}>.`
        })
      } else {
        await respond(
          `<@${body.user.id}> There are no queued or running deployments.`
        )
      }
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
