#!/usr/bin/env node
// Scriptable stand-in for a headless agent CLI, used by unit tests.
// Behaviour is driven by FAKE_CLI_SCRIPT: a JSON array of steps:
//   { "out": "line" }        write a line to stdout
//   { "err": "text" }        write to stderr
//   { "sleep": ms }          wait
//   { "echoStdin": true }    write the received stdin as one stdout line
//   { "spawnChild": true }   start a long-lived grandchild (tests tree kill)
//   { "writeAfterFlag": "-o", "content": "..." }  write content (or the received stdin) to the path that follows the flag in argv
//   { "echoArgs": true }     write argv (after the script path) as one JSON stdout line
//   { "exit": code }         exit with code
const { spawn } = require('child_process')
const { writeFileSync } = require('fs')

const steps = JSON.parse(process.env.FAKE_CLI_SCRIPT || '[]')
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { stdin += chunk })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

process.stdin.on('end', async () => {
  for (const step of steps) {
    if (step.out !== undefined) process.stdout.write(step.out + '\n')
    else if (step.err !== undefined) process.stderr.write(step.err)
    else if (step.sleep !== undefined) await sleep(step.sleep)
    else if (step.echoStdin) process.stdout.write(JSON.stringify(stdin) + '\n')
    else if (step.spawnChild) {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
      process.stdout.write(JSON.stringify({ grandchild: child.pid }) + '\n')
    } else if (step.writeAfterFlag !== undefined) {
      const index = process.argv.indexOf(step.writeAfterFlag)
      if (index > 0) writeFileSync(process.argv[index + 1], step.content ?? stdin, 'utf8')
    } else if (step.echoArgs) process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }) + '\n')
    else if (step.exit !== undefined) process.exit(step.exit)
  }
  process.exit(0)
})
