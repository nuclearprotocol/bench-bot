const { createAppAuth } = require("@octokit/auth-app")
const assert = require("assert")
const fs = require("fs")
const path = require("path")
const { Runner } = require("./runner")

var { benchBranch, benchmarkRuntime } = require("./bench")

const githubCommentLimitLength = 65536
const githubCommentLimitTruncateMessage = "<truncated>..."

let isTerminating = false
let appFatalLogger = undefined

for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, function (error, origin) {
    if (isTerminating) {
      return
    }
    isTerminating = true

    try {
      if (appFatalLogger) {
        appFatalLogger({ event, error, origin })
      }
    } catch (error) {
      console.error({ level: "error", event, error, origin, exception })
    }

    process.exit(1)
  })
}

module.exports = (app) => {
  const runner = new Runner(app)

  appFatalLogger = runner.log.fatal

  if (process.env.DEBUG) {
    runner.log("Running in debug mode")
  }

  const baseBranch = process.env.BASE_BRANCH || "master"
  runner.log.debug(`base branch: ${baseBranch}`)

  const appId = parseInt(process.env.APP_ID)
  assert(appId)

  const clientId = process.env.CLIENT_ID
  assert(clientId)
  const clientSecret = process.env.CLIENT_SECRET
  assert(clientSecret)

  const privateKeyPath = process.env.PRIVATE_KEY_PATH
  assert(privateKeyPath)
  const privateKey = fs.readFileSync(privateKeyPath).toString()
  assert(privateKey)

  const authInstallation = createAppAuth({
    appId,
    privateKey,
    clientId,
    clientSecret,
  })

  app.on("issue_comment", async (context) => {
    let commentText = context.payload.comment.body
    console.log({
      context,
      v1: !context.payload.issue.hasOwnProperty("pull_request"),
      v2: context.payload.action !== "created",
      v3: !commentText.startsWith("/bench"),
    })
    if (
      !context.payload.issue.hasOwnProperty("pull_request") ||
      context.payload.action !== "created" ||
      !commentText.startsWith("/bench")
    ) {
      return
    }

    try {
      const installationId = (context.payload.installation || {}).id
      if (!installationId) {
        await context.octokit.issues.createComment(
          context.issue({
            body: `Error: Installation id was missing from webhook payload`,
          }),
        )
        return
      }

      const getPushDomain = async function () {
        const token = (
          await authInstallation({ type: "installation", installationId })
        ).token

        const url = `https://x-access-token:${token}@github.com`
        return { url, token }
      }

      const repo = context.payload.repository.name
      const owner = context.payload.repository.owner.login
      const pull_number = context.payload.issue.number

      // Capture `<action>` in `/bench <action> <extra>`
      let action = commentText.split(" ").splice(1, 1).join(" ").trim()
      // Capture all `<extra>` text in `/bench <action> <extra>`
      let extra = commentText.split(" ").splice(2).join(" ").trim()

      let pr = await context.octokit.pulls.get({ owner, repo, pull_number })
      const contributor = pr.data.head.user.login
      const branch = pr.data.head.ref
      runner.log.debug(`branch: ${branch}`)

      var { stdout: toolchain, error } = await runner.run(
        "rustup show active-toolchain --verbose",
      )
      if (error) {
        await context.octokit.issues.createComment(
          context.issue({
            body: "ERROR: Failed to query the currently active Rust toolchain",
          }),
        )
        return
      } else {
        toolchain = toolchain.trim()
      }

      const initialInfo = `Starting benchmark for branch: ${branch} (vs ${baseBranch})\n\nToolchain: \n${toolchain}\n\n Comment will be updated.`
      let comment_id = undefined
      if (process.env.DEBUG) {
        runner.log(initialInfo)
      } else {
        const issueComment = context.issue({ body: initialInfo })
        const issue_comment = await context.octokit.issues.createComment(
          issueComment,
        )
        comment_id = issue_comment.data.id
      }

      let config = {
        owner,
        contributor,
        repo,
        branch,
        baseBranch,
        id: action,
        extra,
        getPushDomain,
      }

      let report
      if (action == "runtime" || action == "xcm") {
        report = await benchmarkRuntime(runner, config)
      } else {
        report = await benchBranch(runner, config)
      }
      if (process.env.DEBUG) {
        console.log(report)
        return
      }

      if (report.isError) {
        runner.log.error(report.message)

        if (report.error) {
          runner.log.error(report.error)
        }

        const output = `${report.message}${
          report.error ? `: ${report.error.toString()}` : ""
        }`

        await context.octokit.issues.updateComment({
          owner,
          repo,
          comment_id,
          body: `Error running benchmark: **${branch}**\n\n<details><summary>stdout</summary>${output}</details>`,
        })

        return
      }

      let { title, output, extraInfo, benchCommand } = report

      const bodyPrefix = `
Benchmark **${title}** for branch "${branch}" with command ${benchCommand}

<details>
<summary>Results</summary>

\`\`\`
`.trim()

      const bodySuffix = `
\`\`\`

</details>
`.trim()

      const padding = 16
      const formattingLength =
        bodyPrefix.length + bodySuffix.length + extraInfo.length + padding
      const length = formattingLength + output.length
      if (length >= githubCommentLimitLength) {
        output = `${output.slice(
          0,
          githubCommentLimitLength -
            (githubCommentLimitTruncateMessage.length + formattingLength),
        )}${githubCommentLimitTruncateMessage}`
      }

      const body = `
${bodyPrefix}
${output}
${bodySuffix}

${extraInfo}
`.trim()

      await context.octokit.issues.updateComment({
        owner,
        repo,
        comment_id,
        body,
      })
    } catch (error) {
      runner.logFatalError(error, {
        msg: "Caught exception in issue_comment's handler",
        payload: context.payload,
      })
      if (!process.env.DEBUG) {
        await context.octokit.issues.createComment(
          context.issue({
            body: `Exception caught: \`${error.message}\`\n${error.stack}`,
          }),
        )
      }
    }
  })

  if (fs.existsSync(path.join(__dirname, "payload.json"))) {
    app.receive(
      JSON.parse(
        fs.readFileSync(path.join(__dirname, "payload.json")).toString(),
      ),
    )
  }
}
