import {
  ALLOWED_USERS,
  SLACK_ROOM_PROD,
  SLACK_ROOM_TEST,
  SUPER_USERS
} from './conf.js'

export function isAllowedUser(userId: string): boolean {
  return ALLOWED_USERS.includes(userId)
}

export function isSuperUser(userId: string): boolean {
  return SUPER_USERS.includes(userId)
}

export function isAllowedChannel(channel: string): boolean {
  return channel === SLACK_ROOM_PROD || channel === SLACK_ROOM_TEST
}
