import 'dotenv/config'
import { z } from 'zod'

const str = z.string().nonempty()

export const OCTOKIT_TOKEN = str.parse(process.env.OCTOKIT_TOKEN)
export const SLACK_SIGNING_SECRET = str.parse(process.env.SLACK_SIGNING_SECRET)
export const SLACK_BOT_TOKEN = str.parse(process.env.SLACK_BOT_TOKEN)
export const SLACK_APP_TOKEN = str.parse(process.env.SLACK_APP_TOKEN)
export const SLACK_ROOM_PROD = str.parse(process.env.SLACK_ROOM_PROD)
export const SLACK_ROOM_TEST = str.parse(process.env.SLACK_ROOM_TEST)

export const SENTRY_DSN = z.string().optional().parse(process.env.SENTRY_DSN)

export const ALLOWED_USERS = str.parse(process.env.ALLOWED_USERS).split(',')
export const SUPER_USERS = str.parse(process.env.SUPER_USERS).split(',')

export const ANSIBLE_ROOT = str.parse(process.env.ANSIBLE_ROOT)
export const ANSIBLE_BIN = str.parse(process.env.ANSIBLE_BIN)
export const ANSIBLE_PLAYBOOK = str.parse(process.env.ANSIBLE_PLAYBOOK)
export const CHECK_REPOS = str.parse(process.env.CHECK_REPOS).split(',')

export const DEPLOYMENT_HIGHLIGHTS = str
  .parse(process.env.DEPLOYMENT_HIGHLIGHTS)
  .split(',')
  .map((s) => new RegExp(`TASK \\[(\\w+ : )?(${s})\\]`))
