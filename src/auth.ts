import { ALLOWED_USERS, SUPER_USERS } from './conf.js'

export function isAllowedUser(userId: string): boolean {
  return ALLOWED_USERS.includes(userId)
}

export function isSuperUser(userId: string): boolean {
  return SUPER_USERS.includes(userId)
}

export function isAllowedChannel(channel: string): boolean {
  return (
    channel === process.env.SLACK_ROOM_PROD ||
    channel === process.env.SLACK_ROOM_TEST
  )
}
