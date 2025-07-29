/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS205: Consider reworking code to avoid use of IIFEs
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/main/docs/suggestions.md
 */
// Description:
//   Deployment von FragDenStaat
//
// Commands:
//   fdsbot deploy - Shows what can be deployed
//   fdsbot deploy <tag> - Deploy that tag
//   fdsbot force deploy <tag> - Deploy that tag without checks
//   fdsbot cancel deploy
//   fdsbot last deploy
//

const { Octokit } = require("@octokit/core");
const octokit = new Octokit({ auth: process.env.OCTOKIT_TOKEN });

const child_process = require("child_process");

const ALLOWED_USERS = process.env.ALLOWED_USERS.split(",");
const SUPER_USERS = process.env.SUPER_USERS.split(",");
const ROOM = process.env.SLACK_ROOM;

const CHECK_REPOS = process.env.CHECK_REPOS.split(",");

if (!Array.prototype.flat) {
  Object.defineProperty(Array.prototype, 'flat', {
    configurable: true,
    writable: true,
    value: function () {
      var depth =
        typeof arguments[0] === 'undefined' ? 1 : Number(arguments[0]) || 0;
      var result = [];
      var forEach = result.forEach;

      var flatDeep = function (arr, depth) {
        forEach.call(arr, function (val) {
          if (depth > 0 && Array.isArray(val)) {
            flatDeep(val, depth - 1);
          } else {
            result.push(val);
          }
        });
      };

      flatDeep(this, depth);
      return result;
    },
  });
}

const ansible_path = "../fragdenstaat.de-ansible";

const DEPLOYMENT_HIGHLIGHTS = [
  /TASK \[appserver : (Reload application)\]/,
  /TASK \[appserver : (Run yarn setup script)\]/,
  /TASK \[app : (Run Django database migrations)\]/,
  /TASK \[app : (Install packages required by the Django app inside virtualenv)\]/,
  /TASK \[celery : (Update celery workers)\]/,
];

const DEPLOYMENT_PROCESS = {};

const repoNameFromUrl = (url) => url.split("/")[5]

const collectChecks = check_repos => new Promise(function (resolve, reject) {
  const promises = (Array.from(check_repos).map((path) => octokit.request(`GET /repos/${path}/commits/main/check-runs`)));
  return Promise.all(promises).then(function (results) {
    const checks = (Array.from(results).map((result) => result.data.check_runs.filter((run) => /^(test|lint)/.test(run.name)))).flat();
    const pending = [];
    const failed = [];
    for (let check of checks) {
      if (!check) {
        continue;
      }
      const checkData = {url: check.html_url, name: check.name, repo: repoNameFromUrl(check.url)}
      if (check.status !== "completed") {
        pending.push(checkData);
      } else if (check.conclusion !== "success") {
        failed.push(checkData);
      }
    }
    if (pending.length > 0 || failed.length > 0) {
      return reject({ pending, failed });
    }
    return resolve(checks);
  });
});

var _runChecks = (pending_callback, resolve, reject, first) => collectChecks(CHECK_REPOS).then(
  checks => resolve(checks),
  bad_checks => {
    if (bad_checks.failed.length > 0) {
      return reject(`Checks failed for: ${bad_checks.failed.map(f => `<${f.url}|${f.repo}: ${f.name}>`).join(", ")}`);
    } else if (bad_checks.pending.length > 0) {
      if (first) {
        pending_callback(bad_checks.pending);
      }
      // Try again
      return setTimeout(() => _runChecks(pending_callback, resolve, reject, false)
        , 1000 * 60 * 2);
    }
  });

const runChecks = pending_callback => new Promise((resolve, reject) => _runChecks(pending_callback, resolve, reject, true));


module.exports = function (robot) {

  robot.receiveMiddleware(function (context, next, done) {
    if (context.response.message.room !== ROOM) {
      context.response.message.finish();
      context.response.reply("I only work in the fragdenstaat-alerts channel!");
      return done();
    }

    if (!Array.from(ALLOWED_USERS).includes(context.response.message.user.name)) {
      context.response.message.finish();

      // If the message starts with 'hubot' or the alias pattern, this user was
      // explicitly trying to run a command, so respond with an error message.
      if (context.response.message.text != null ? context.response.message.text.match(robot.respondPattern('')) : undefined) {
        context.response.reply(`Hey ${context.response.message.user.name}, you are not allowed to talk to me! Please ask one of: ${ALLOWED_USERS.join(', ')}`);
      }

      // Don't process further middleware.
      return done();
    } else {
      return next(done);
    }
  });

  const check_running = function (res) {
    const deploying = robot.brain.get('deployment') || null;
    if (deploying !== null) {
      const deploy_secs = Math.floor((new Date().getTime() - deploying.time) / 1000);
      res.reply(`A deployment by ${deploying.user} for ${deploying.tags} is running for ${deploy_secs} seconds.`);
      return true;
    }
    return false;
  };

  const log_start_deployment = function (user, deploy_tag) {
    robot.brain.set('deployment', { user, time: new Date().getTime(), tags: deploy_tag });
    const deployments = robot.brain.get('deployments') || [];
    deployments.push({
      user,
      tags: deploy_tag,
      start: new Date().toISOString()
    });
    return robot.brain.set('deployments', deployments);
  };

  const log_deployment = function (text) {
    const deployments = robot.brain.get('deployments') || [];
    const last_deployment = deployments[deployments.length - 1];
    if (!last_deployment.text) {
      last_deployment.text = "";
    }
    return last_deployment.text += `\n${text}`;
  };

  const log_end_deployment = function (code) {
    robot.brain.set('deployment', null);
    const deployments = robot.brain.get('deployments') || [];
    const last_deployment = deployments[deployments.length - 1];
    last_deployment.code = code;
    last_deployment.end = new Date().toISOString();
    robot.brain.set('deployments', deployments);
    return last_deployment.text;
  };

  const log_cancel_deployment = function (user) {
    robot.brain.set('deployment', null);
    const deployments = robot.brain.get('deployments') || [];
    const last_deployment = deployments[deployments.length - 1];
    last_deployment.end = new Date().toISOString();
    last_deployment.canceled = true;
    last_deployment.canceled_by = user;
    return robot.brain.set('deployments', deployments);
  };

  const log_abort_deployment = () => log_cancel_deployment(null);

  const handle_ansible_complete = function (res, code, signal) {
    if (code === null) {
      res.reply("Deployment aborted.");
    }

    if (code !== 0) {
      const text = log_end_deployment(code);
      if (!res) {
        return;
      }
      res.reply("Deployment failed!");
      return res.send({
        attachments: [
          {
            title: "Deployment failed.",
            text: `${text}`,
            fallback: `${text}`,
            color: "#900",
            mrkdwn_in: []
          }
        ]
      });
    } else {
      log_end_deployment(code);
      if (!res) {
        return;
      }
      return res.reply("Deployment complete.");
    }
  };

  const setup_ansible = function (res, tag) {
    let tags;
    var tag;
    console.log(`run ansible with ${tag}`);
    if (tag === "all") {
      tags = ["backend", "frontend"];
    } else {
      tags = [tag];
    }
    const make_tag = t => `deploy-${t}`;
    tags = ((() => {
      const result = [];
      for (tag of Array.from(tags)) {
        result.push(make_tag(tag));
      }
      return result;
    })());
    const args = ["playbooks/fragdenstaat.de.yml"];
    for (let t of Array.from(tags)) {
      args.push('-t');
      args.push(t);
    }

    console.log(tags);
    return child_process.exec("git pull origin main", { cwd: `${ansible_path}` }, function (e) {
      if (e) {
        console.error('Git pull failed', e);
        return;
      }
      return run_ansible(res, args);
    });
  };

  var run_ansible = function (res, args) {
    const command = "./ansible-env/bin/ansible-playbook";
    const child = child_process.spawn(command, args, {
      cwd: `${ansible_path}`,
    });
    DEPLOYMENT_PROCESS.child = child;
    child.stdout.on('data', function (data) {
      const text = data.toString();
      log_deployment(text);
      return (() => {
        const result = [];
        for (let highlight of Array.from(DEPLOYMENT_HIGHLIGHTS)) {
          const match = highlight.exec(text);
          if (match) {
            result.push(res.send(`Deployment progress: ${match[1]}`));
          } else {
            result.push(undefined);
          }
        }
        return result;
      })();
    });

    child.stderr.on('data', function (data) {
      const text = data.toString();
      console.log("child stderr data", text);
      return log_deployment(text);
    });

    return child.on('exit', function (code, signal) {
      console.log("child close", code, signal);
      DEPLOYMENT_PROCESS.child = null;
      return handle_ansible_complete(res, code, signal);
    });
  };

  const start_deploy = function (res, deploy_tag) {
    console.log(`Deploying ${deploy_tag}`);
    res.reply(`Deploying ${deploy_tag}...`);
    return setup_ansible(res, deploy_tag);
  };

  robot.respond(/deploy\s*$/, function (res) {
    if (check_running(res)) {
      return;
    }
    return res.reply(`${res.message.user.name}, what should I deploy? Choose one of web, frontend, backend, all. Say: fdsbot deploy <tag>`);
  });

  robot.respond(/deploy (web|frontend|backend|all)/i, function (res) {
    if (check_running(res)) {
      return;
    }
    const deploy_tag = res.match[1];

    log_start_deployment(res.message.user.name, deploy_tag);
    res.reply("Running deployment checks");
    return runChecks(pending => res.reply("Checks are pending, deployment will continue automatically when checks pass.")).then(() => {
      console.log("Checks ok!");
      const deploying = robot.brain.get('deployment') || null;
      if (!deploying) {
        // deployment was canceled in the mean time
        return;
      }
      return start_deploy(res, deploy_tag);
    }
      , function (bad_checks) {
        log_abort_deployment();
        console.log("Bad Checks!");
        return res.reply(`Cannot deploy, checks have failed: ${bad_checks}`);
      });
  });

  robot.respond(/force deploy (web|frontend|backend|all)/i, function (res) {
    if (check_running(res)) {
      return;
    }
    if (!Array.from(SUPER_USERS).includes(res.message.user.name)) {
      return res.reply("You cannot force deploy.");
    }
    const deploy_tag = res.match[1];
    res.reply("Deploying without checks! If this breaks, blame is on you!");
    return start_deploy(res, deploy_tag);
  });

  robot.respond(/cancel deploy/, function (res) {
    if (check_running(res)) {
      if (DEPLOYMENT_PROCESS.child) {
        if (!DEPLOYMENT_PROCESS.child.kill('SIGINT')) {
          DEPLOYMENT_PROCESS.child.kill('SIGTERM');
        }
        DEPLOYMENT_PROCESS.child = null;
        log_cancel_deployment(res.message.user.name);
        return res.reply("deployment canceled!");
      }
      log_cancel_deployment(res.message.user.name);
      return res.reply("deployment process not found, canceled anyway!");
    }
    return res.reply("No deployments are running.");
  });

  robot.respond(/last deploy/, function (res) {
    let last;
    const deployments = robot.brain.get('deployments') || [];
    if (check_running(res)) {
      last = deployments[deployments.length - 2];
    } else {
      last = deployments[deployments.length - 1];
    }
    if (last) {
      res.reply(`The last deployment was by ${last.user} from ${last.start} to ${last.end}.`);
      if (last.canceled) {
        res.reply(`It was canceled by ${last.canceled_by}.`);
      }
      return;
    }
    return res.reply("Could not find any deployments.");
  });

  robot.enter(res => res.send(`Hey @${res.message.user.name}! Willkommen im fragdenstaat-alerts-Channel!`));

  return robot.error(function (err, res) {
    robot.logger.error("DOES NOT COMPUTE");

    if (res != null) {
      return res.reply("DOES NOT COMPUTE");
    }
  });
};
