import * as Sentry from '@sentry/node'
if (process.env.SENTRY_DSN)
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 1.0
  })
else {
  console.warn('Sentry DSN is not set, Sentry will not be initialized.')
}
