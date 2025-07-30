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

export class CheckError extends Error {
  failedChecks: CheckData[]
  pendingChecks: CheckData[]
  constructor(failed: CheckData[], pending: CheckData[]) {
    super('There are failed or pending checks')
    this.failedChecks = failed
    this.pendingChecks = pending
  }
}

export async function collectChecks(repos: string[]): Promise<boolean> {
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
  const checks = results.flatMap((result) => result.data.check_runs)
  const pending: CheckData[] = []
  const failed: CheckData[] = []

  for (const check of checks) {
    if (!check) {
      continue
    }

    const checkData: CheckData = {
      url: check.html_url,
      name: check.name,
      repo: repoNameFromUrl(check.url)
    }
    if (check.status !== 'completed') {
      pending.push(checkData)
    } else if (check.conclusion !== 'success' && check.name !== 'Dependabot') {
      failed.push(checkData)
    }
  }
  if (pending.length > 0 || failed.length > 0) {
    throw new CheckError(failed, pending)
  }

  return true
}

export async function runChecks(
  repos: string[],
  pendingCallback: (pendingChecks: CheckData[]) => void,
  signal?: AbortSignal,
  first = true
): Promise<boolean> {
  if (signal?.aborted) {
    return false
  }

  try {
    return collectChecks(repos)
  } catch (error) {
    if (error instanceof CheckError) {
      const { failedChecks, pendingChecks } = error

      if (failedChecks.length > 0) {
        throw error
      } else if (pendingChecks.length > 0) {
        if (first) {
          pendingCallback(pendingChecks)
        }

        // checks are pending, try again in 2 minutes
        if (await wait(1000 * 60 * 2, signal))
          return await runChecks(repos, pendingCallback, signal, false)
        return false
      }
    }

    throw error
  }
}
