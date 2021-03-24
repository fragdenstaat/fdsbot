# Description:
#   Deployment von FragDenStaat
#
# Commands:
#   fdsbot deploy - Shows what can be deployed
#   fdsbot deploy <tag> - Deploy that tag
#   fdsbot force deploy <tag> - Deploy that tag without checks
#   fdsbot cancel deploy
#   fdsbot last deploy
#

{ Octokit } = require("@octokit/core")
octokit = new Octokit({ auth: process.env.OCTOKIT_TOKEN })

child_process = require "child_process"

ALLOWED_USERS = ['stefanw', 'magda', 'arnese', 'Max']
SUPER_USERS = ['stefanw']
ROOM = "G5KALBN4F"

CHECK_REPOS = [
  "/repos/okfde/froide/commits/main/check-runs",
  "/repos/okfde/fragdenstaat_de/commits/master/check-runs",
]

ansible_path = "../fragdenstaat.de-ansible"

DEPLOYMENT_HIGHLIGHTS = [
  /TASK \[web : (Reload application)\]/,
  /TASK \[web : (Run yarn setup script)\]/,
  /TASK \[web : (Run Django database migrations)\]/,
  /TASK \[web : (Install packages required by the Django app inside virtualenv)\]/
]

DEPLOYMENT_PROCESS = {}

runChecks = () ->
  return new Promise((resolve, reject) ->
    promises = (octokit.request("GET #{path}") for path in CHECK_REPOS)
    Promise.all(promises).then((results) ->
      checks = (result.data.check_runs[0] for result in results)
      bad_checks = []
      for check in checks
        if check.status != "completed" or check.conclusion != "success"
          bad_checks.push(check.html_url)
      if bad_checks.length > 0
        return reject("#{bad_checks.join(" | ")}")
      return resolve(checks)
    )
  )


module.exports = (robot) ->

  robot.receiveMiddleware (context, next, done) ->
    if context.response.message.room != ROOM
      context.response.message.finish()
      context.response.reply "Ich funktioniere nur im fragdenstaat-alerts channel!"
      return done()

    if not context.response.message.user.name in ALLOWED_USERS
      context.response.message.finish()

      # If the message starts with 'hubot' or the alias pattern, this user was
      # explicitly trying to run a command, so respond with an error message.
      if context.response.message.text?.match(robot.respondPattern(''))
        context.response.reply "Hey #{context.response.message.user.name}, du darfst leider nicht mir sprechen! Frag doch bitte: #{ALLOWED_USERS.join(', ')}"

      # Don't process further middleware.
      return done()
    else
      return next(done)

  check_running = (res) ->
    deploying = robot.brain.get('deployment') or null
    if deploying != null
      deploy_secs = Math.floor((new Date().getTime() - deploying.time) / 1000)
      res.reply "Ein Deployment angestoßen von #{deploying.user} läuft gerade seit #{deploy_secs} Sekunden."
      return true
    return false

  log_start_deployment = (user, tags) ->
    robot.brain.set 'deployment', { user: user, time: new Date().getTime() }
    deployments = robot.brain.get('deployments') or []
    deployments.push({
      user: user,
      tags: tags,
      start: new Date().toISOString()
    })
    robot.brain.set('deployments', deployments)

  log_deployment = (text) ->
    deployments = robot.brain.get('deployments') or []
    last_deployment = deployments[deployments.length - 1]
    if not last_deployment.text
      last_deployment.text = ""
    last_deployment.text += "\n#{text}"

  log_end_deployment = (code) ->
    robot.brain.set 'deployment', null
    deployments = robot.brain.get('deployments') or []
    last_deployment = deployments[deployments.length - 1]
    last_deployment.code = code
    last_deployment.end = new Date().toISOString()
    robot.brain.set('deployments', deployments)
    return last_deployment.text

  log_cancel_deployment = (user) ->
    robot.brain.set 'deployment', null
    deployments = robot.brain.get('deployments') or []
    last_deployment = deployments[deployments.length - 1]
    last_deployment.end = new Date().toISOString()
    last_deployment.canceled = true
    last_deployment.canceled_by = user
    robot.brain.set('deployments', deployments)

  handle_ansible_complete = (res, code, signal) ->
    if code == null
      res.reply "Deployment aborted."

    if code != 0
      text = log_end_deployment(code)
      if not res
        return
      res.reply "Deployment failed!"
      res.send({
        attachments: [
          {
            title: "Deployment failed."
            text: "#{text}"
            fallback: "#{text}"
            color: "#900"
            mrkdwn_in: []
          }
        ]
      })
    else
      log_end_deployment(code)
      if not res
        return
      res.reply "Deployment complete."

  setup_ansible = (res, tag) ->
    console.log("run ansible with #{tag}")
    if tag == "all"
      tags = ["backend", "frontend"]
    else
      tags = [tag]
    make_tag = (t) -> "deploy-#{t}"
    tags = (make_tag tag for tag in tags)
    args = ["fragdenstaat.de.yml"]
    for t in tags
      args.push('-t')
      args.push(t)

    console.log(tags)
    child_process.exec("git pull origin master", { cwd: "#{ansible_path}" }, (e) ->
      if e
        console.error('Git pull failed', e)
        return
      run_ansible(res, args)
    )

  run_ansible = (res, args) ->
    command = "./ansible-env/bin/ansible-playbook"
    child = child_process.spawn(command, args, {
      cwd: "#{ansible_path}",
    })
    DEPLOYMENT_PROCESS.child = child
    child.stdout.on 'data', (data) ->
      text = data.toString()
      log_deployment(text)
      for highlight in DEPLOYMENT_HIGHLIGHTS
        match = highlight.exec(text)
        if match
          res.send "Deployment progress: #{match[1]}"

    child.stderr.on 'data', (data) ->
      text = data.toString()
      console.log("child stderr data", text)
      log_deployment(text)

    child.on('exit', (code, signal) ->
      console.log("child close", code, signal)
      DEPLOYMENT_PROCESS.child = null
      handle_ansible_complete(res, code, signal)
    )

  start_deploy = (res, deploy_tag) ->
    console.log("Deploying #{deploy_tag}")
    res.reply "Deploying #{deploy_tag}..."
    log_start_deployment(res.message.user.name, deploy_tag)
    setup_ansible(res, deploy_tag)

  robot.respond /deploy\s*$/, (res) ->
    if check_running(res)
      return
    return res.reply "#{res.message.user.name}, was soll ich deployen? Wähle zwischen web, frontend, backend, all. Sage fdsbot deploy <tag>"

  robot.respond /deploy (web|frontend|backend|all)/i, (res) ->
    if check_running(res)
      return
    deploy_tag = res.match[1]

    res.reply "Running deployment checks"
    runChecks().then(() ->
      console.log("Checks ok!")
      start_deploy(res, deploy_tag)
    , (bad_checks) ->
      console.log("Bad Checks!")
      res.reply("Cannot deploy because checks failed: #{bad_checks}")
    )

  robot.respond /force deploy (web|frontend|backend|all)/i, (res) ->
    if check_running(res)
      return
    if not res.message.user.name in SUPER_USERS
      return res.reply "You cannot force deploy."
    deploy_tag = res.match[1]
    res.reply "Deploying without checks! If this breaks, blame is on you!"
    start_deploy(res, deploy_tag)

  robot.respond /cancel deploy/, (res) ->
    if check_running(res)
      if DEPLOYMENT_PROCESS.child
          if not DEPLOYMENT_PROCESS.child.kill('SIGINT')
            DEPLOYMENT_PROCESS.child.kill('SIGTERM')
          DEPLOYMENT_PROCESS.child = null
          log_cancel_deployment(res.message.user.name)
          return res.reply "deployment abgebrochen!"

      return res.reply "deployment konnte nicht abgebrochen werden!"
    return res.reply "es läuft kein deployment."

  robot.respond /last deploy/, (res) ->
    deployments = robot.brain.get('deployments') or []
    if check_running(res)
      last = deployments[deployments.length - 2]
    else
      last = deployments[deployments.length - 1]
    if last
      res.reply "das letzte deployment war von #{last.user} von #{last.start} bis #{last.end}."
      if last.canceled
        res.reply "es wurde von #{last.canceled_by} abgebrochen."
      return
    return res.reply "konnte kein deployment finden."

  robot.enter (res) ->
    res.send "Hey @#{res.message.user.name}! Willkommen im fragdenstaat-alerts-Channel!"

  robot.error (err, res) ->
    robot.logger.error "DOES NOT COMPUTE"

    if res?
      res.reply "DOES NOT COMPUTE"
