import { Octokit } from '@octokit/core'
import { wait } from './utils.js'
import { OCTOKIT_TOKEN } from './conf.js'

const octokit = new Octokit({ auth: OCTOKIT_TOKEN })

const repoNameFromUrl = (url: string) => url.split('/')[5]

export interface CheckData {
  url: string | null
  name: string
  repo: string
}

export interface CheckRun {
  pending: CheckData[]
  failed: CheckData[]
}

export async function* collectChecks(
  repos: string[]
): AsyncGenerator<CheckRun> {
  const promises = repos.map((path) => {
    const [owner, repo] = path.split('/') as [string, string]
    return octokit.request(
      `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`,
      {
        owner,
        repo,
        ref: 'main'
      }
    )
  })

  const results = await Promise.all(promises)
  const checks = results
    .flatMap((result) => result.data.check_runs)
    .filter((check) => check.name !== 'Dependabot')
  const pending: CheckData[] = []
  const failed: CheckData[] = []

  for (const check of checks) {
    const checkData: CheckData = {
      url: check.html_url,
      name: check.name,
      repo: repoNameFromUrl(check.url)
    }
    if (check.status === 'in_progress') {
      pending.push(checkData)
    } else if (check.conclusion !== 'success') {
      failed.push(checkData)
    }
  }

  yield { pending, failed } as CheckRun

  if (pending.length !== 0) {
    // wait 60 seconds before checking again, unless aborted
    await wait(1000 * 60)
    yield* collectChecks(repos)
  }
}
