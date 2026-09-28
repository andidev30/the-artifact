#!/usr/bin/env node
import { main } from './main.ts'

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  readStdin,
  openBrowser: !process.env.CI,
})
