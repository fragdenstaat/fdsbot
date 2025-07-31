import z from 'zod'
import EventEmitter from 'node:events'
import { CheckData, collectChecks } from './github.js'
import { promisify } from 'node:util'
import child_process, { type ExecException } from 'node:child_process'
import {
  ANSIBLE_BIN,
  ANSIBLE_PLAYBOOK,
  ANSIBLE_ROOT,
  DEPLOYMENT_HIGHLIGHTS,
  CHECK_REPOS
} from './conf.js'

const exec = promisify(child_process.exec)

export class AnsibleError extends Error {
  constructor(
    message: string,
    public readonly stdout = '',
    public readonly stderr = '',
    public readonly out = ''
  ) {
    super(message)
  }
}

const deployments: Map<string, DeploymentProcess> = new Map()

export const tagSchema = z.enum(['web', 'backend', 'frontend', 'all'])
export type DeploymentTag = z.infer<typeof tagSchema>

export type DeploymentState =
  | 'queued'
  | 'checking'
  | 'updating'
  | 'ready'
  | 'running'
  | 'done'
  | 'error'
  | 'aborted'

export const FINAL_STATES: DeploymentState[] = ['done', 'error', 'aborted']

export class DeploymentProcess extends EventEmitter<{
  state: [DeploymentState]
  progress: [string]
}> {
  private _state: DeploymentState = 'queued'
  public tag: DeploymentTag
  public createdAt: Date = new Date()
  public abort: AbortController
  public abortedBy?: string
  public child?: child_process.ChildProcess
  public stdout = ''
  public stderr = ''
  public out = ''

  public cwd = ANSIBLE_ROOT
  public ansiblePath = ANSIBLE_BIN
  public playbook = ANSIBLE_PLAYBOOK
  public highlights: RegExp[] = DEPLOYMENT_HIGHLIGHTS

  public get state(): typeof this._state {
    return this._state
  }

  private set state(newState: DeploymentState) {
    if (
      FINAL_STATES.includes(this._state) &&
      FINAL_STATES.includes(newState) === false
    ) {
      throw new Error(
        `Cannot change state from "${this._state}" to "${newState}"`
      )
    }
    this._state = newState
    this.emit('state', newState)
  }

  constructor(
    public user: string,
    tag: string,
    private ansibleArgs: string[] = []
  ) {
    super()

    this.tag = tagSchema.parse(tag)
    this.abort = new AbortController()

    this.abort.signal.addEventListener('abort', () => {
      this.state = 'aborted'
    })
  }

  public isRunning(): boolean {
    return this.state === 'running' || this.state === 'updating'
  }

  public safeToClear(): boolean {
    return FINAL_STATES.includes(this.state)
  }

  public runningSince(): number {
    return Math.floor((new Date().getTime() - this.createdAt.getTime()) / 1000)
  }

  public async runChecks(
    pendingCallback: (pendingChecks: CheckData[]) => void
  ): Promise<boolean | CheckData[]> {
    this.state = 'checking'

    const checks = collectChecks(CHECK_REPOS)
    this.abort.signal.addEventListener('abort', () => {
      checks.return(undefined)
    })

    let first = true
    for await (const check of checks) {
      if (check.pending.length !== 0 && first) {
        first = false
        pendingCallback(check.pending)
      }

      if (check.failed.length !== 0) {
        this.state = 'error'
        return check.failed
      }
    }

    if (this.abort.signal.aborted) {
      return false
    }

    this.state = 'ready'
    return true
  }

  public async updateRepo(): Promise<boolean> {
    if (this.state !== 'queued') {
      return false
    }

    this.state = 'updating'

    try {
      await exec('git pull origin main', {
        cwd: this.cwd,
        timeout: 30000,
        signal: this.abort.signal
      })
      this.state = 'ready'

      return true
    } catch (error) {
      this.state = 'error'
      throw new AnsibleError(
        `Failed to pull Ansible repo with Git`,
        (error as ExecException).stdout,
        (error as ExecException).stderr
      )
    }
  }

  public async runPlaybook(): Promise<boolean> {
    if (this.state !== 'ready') {
      return false
    }

    this.state = 'running'

    if (this.child) {
      throw new Error('Ansible playbook is already running')
    }

    const tags =
      this.tag === 'all'
        ? ['deploy-backend', 'deploy-frontend']
        : [`deploy-${this.tag}`]

    const args = [
      ...this.ansibleArgs,
      ...tags.flatMap((t) => ['-t', t]),
      this.playbook
    ]

    return new Promise((resolve, reject) => {
      console.log('Running Ansible playbook with args:', args)

      const child = child_process.spawn(this.ansiblePath, args, {
        cwd: this.cwd,
        signal: this.abort.signal
      })
      this.child = child

      child.stdout.on('data', (data) => {
        const text = data.toString()

        this.stdout += text
        this.out += text

        for (const highlight of this.highlights) {
          const match = highlight.exec(text)
          if (match) {
            this.emit('progress', match[2])
          }
        }
      })

      child.stderr.on('data', (data) => {
        const text = data.toString()
        this.stderr += text
        this.out += text
      })

      child.on('close', (code) => {
        if (code !== 0) {
          const error = new AnsibleError(
            `Ansible playbook failed with code ${code}`,
            this.stdout,
            this.stderr,
            this.out
          )
          this.state = 'error'
          reject(error)
        } else {
          this.state = 'done'
          console.log('Ansible playbook finished successfully')
          resolve(true)
        }
      })

      child.on('error', (error) => {
        if (error.name === 'AbortError') {
          this.state = 'aborted'
          resolve(false)
        } else {
          this.state = 'error'
          reject(error)
        }
      })
    })
  }
}

export function getDeployment(id: string): DeploymentProcess | undefined {
  return deployments.get(id)
}

export function getAllDeployments(): Array<[string, DeploymentProcess]> {
  return [...deployments.entries()]
}

export function canCreateDeployment(id: string): boolean {
  return deployments.get(id)?.safeToClear() ?? true
}

/**
 * Create a new deployment process, if one is not already running.
 */
export function createDeployment(
  id: string,
  ...args: ConstructorParameters<typeof DeploymentProcess>
): DeploymentProcess {
  if (!canCreateDeployment(id)) {
    throw new Error('There is already a running deployment')
  }

  clearDeployment(id)

  const proc = new DeploymentProcess(...args)
  deployments.set(id, proc)
  return proc
}

/**
 * Cancel the current deployment if it is running.
 * @returns `true` if a deployment was running and has been cancelled, `false` otherwise.
 */
export function cancelDeployment(id: string, user?: string): boolean {
  const proc = deployments.get(id)
  if (!proc) {
    return false
  }

  proc.abortedBy = user
  proc.abort.abort('Deployment cancelled by user')
  deployments.delete(id)
  return true
}

/**
 * Clear the current deployment, before it starts running.
 * @returns `true` if there was no deployment or it could be cleared before running, `false` if a deployment was running.
 */
export function clearDeployment(id: string): boolean {
  const proc = deployments.get(id)
  proc?.abort.abort('Deployment cleared by system')
  if (proc?.isRunning()) {
    return false
  }

  return deployments.delete(id)
}

/**
 * Cancel or clear all deployments.
 * @returns `true` if there were deployments that were cancelled or cleared, `false`
 */
export function cancelAllDeployments(user?: string): boolean {
  const isRunning = deployments.entries().some(([, proc]) => proc.isRunning())

  for (const proc of deployments.values()) {
    proc.abortedBy = user
    proc.abort.abort('Deployment cancelled by user')
  }

  deployments.clear()

  return isRunning
}
