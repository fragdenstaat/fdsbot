import type {
  BlockAction,
  ButtonAction,
  Middleware,
  SlackActionMiddlewareArgs,
  SlackEventMiddlewareArgs
} from '@slack/bolt'
import {
  ALLOWED_USERS,
  SLACK_ROOM_PROD,
  SLACK_ROOM_TEST,
  SUPER_USERS
} from './conf.js'

export function isAllowedUser(userId?: string): boolean {
  if (!userId) return false
  return ALLOWED_USERS.includes(userId)
}

export function isSuperUser(userId?: string): boolean {
  if (!userId) return false
  return SUPER_USERS.includes(userId)
}

export function isAllowedChannel(channel?: string): boolean {
  if (!channel) return false
  return channel === SLACK_ROOM_PROD || channel === SLACK_ROOM_TEST
}

export const mentionAuthMiddleware: Middleware<
  SlackEventMiddlewareArgs<'app_mention'>
> = async ({ payload, next, client }) => {
  // main auth middleware - check that user and channel are allowed
  const { channel, user } = payload

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
}

export const actionAuthMiddleware: Middleware<
  SlackActionMiddlewareArgs<BlockAction<ButtonAction>>
> = async ({ body, respond, action, next }) => {
  // auth middleware for actions - check that user is allowed
  if (
    action.type === 'button' &&
    action.value &&
    isAllowedUser(body.user.id) &&
    isAllowedChannel(body.channel?.id)
  ) {
    await next()
  } else {
    await respond('You are not allowed to trigger this action.')
  }
}
