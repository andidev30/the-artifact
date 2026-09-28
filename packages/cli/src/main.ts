import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { callTool, canUpload, type PageContent, publishByUpload, publishPage, type Published, StorageUnreachable, VERSION, whoami } from './api.ts'
import { browserLogin, resolveAuth, resolveServer, revoke } from './auth.ts'
import { type Env, normalizeServer, readCredentials, readLink, saveLink, type Saved, updateCredentials, LINK_FILE } from './config.ts'
import { CliError, SignedOutError, UsageError } from './errors.ts'
import { checkLimits, collectPage, collectSome, ENTRY_PATH, fallbackTitle, formatBytes, readPage, titleFromHtml } from './files.ts'
import { type Clock, relevantChange, runWatch, type Subscribe, watchFolder } from './watch.ts'

export type Io = {
  env: Env
  cwd: string
  stdout: { write(s: string): unknown; isTTY?: boolean }
  stderr: { write(s: string): unknown; isTTY?: boolean }
  readStdin: () => Promise<string>
  openBrowser: boolean
  // Aborts on Ctrl+C, for commands that run until then (publish --watch). Only asked for by them, so
  // Ctrl+C stops every other command the usual way.
  interrupted?: () => AbortSignal
  // For tests of publish --watch: what reports changes, and the timers
  watch?: { subscribe?: (root: string, relevant: (path: string) => boolean) => Subscribe; clock?: Clock; debounceMs?: number }
}

const HELP = `Publish HTML pages to The Artifact.

Usage: the-artifact <command> [options]

Commands:
  publish <folder|file.html>   Publish a page, or a new version of one, and print its link
  list                         List the pages in your workspace
  share <page>                 Change who can open a page, or share it with people by email
  login                        Sign in with the browser, or save an access token (--with-token)
  logout                       Sign out of a server
  whoami                       Show who you're signed in as, and in which workspace

Options for every command:
  --server <url>    Your server, e.g. https://artifact.example.com (or THE_ARTIFACT_URL). Default: the hosted service
  --token <token>   An access token from settings (or THE_ARTIFACT_TOKEN), instead of signing in
  --json            Print JSON, for scripts
  -h, --help        Show help for a command
  -v, --version     Show the version

Run the-artifact <command> --help for a command's options.`

const COMMAND_HELP: Record<string, string> = {
  publish: `Usage: the-artifact publish <folder|file.html> [options]

Publishes a folder (its index.html and the files next to it) or one HTML file, and prints the link.
Hidden files, node_modules and files of types pages can't hold are left out.

Options:
  --title <title>        The page's title. Default: the HTML's <title>, or the folder's name
  --id <page>            Publish a new version of this page (its id or link)
  --entry <path>         The HTML file in the folder that is the page. Default: index.html
  --visibility <who>     restricted, organization or link
  --folder <name>        File the page into this folder of the workspace ("" for no folder)
  --ignore <glob>        Leave out matching files; repeat for more (e.g. --ignore '*.map')
  --only <path>          Send only this file (or glob) and keep the page's other files as they are;
                         repeat for more (e.g. --only data.json). Needs --id or a saved page
  --remove <path>        Remove this file from the page and keep the others; repeat for more
  --save                 Remember the page in ${LINK_FILE}, so later publishes update it
  --new                  Publish a new page even if ${LINK_FILE} has one for this path
  --watch                Keep watching, and publish a new version whenever files change, until Ctrl+C
  --poll                 With --watch: look for changes every second, where file events don't arrive
  --dry-run              List what would be sent, and send nothing`,
  list: `Usage: the-artifact list [options]

Lists the pages in the workspace you're signed in to, most recently updated first.

Options:
  --query <words>    Only pages whose title contains this
  --folder <name>    Only pages in this folder ("" for pages in no folder)
  --limit <n>        How many, 1 to 100. Default: 25
  --cursor <cursor>  Continue a previous list`,
  share: `Usage: the-artifact share <page> [options]

Changes who can open a page, or shares it with people by email. <page> is its id or link.

Options:
  --visibility <who>   restricted (you and the people it's shared with), organization, or link
  --expires <date>     The link stops working after this date (YYYY-MM-DD, end of day UTC); never to remove
  --password <text>    People who open the link must enter this password; "" to remove
  --new-link           Reset the public link: earlier public links stop working
  --email <address>    Share with this person; repeat for more. They get an email with the link
  --role <role>        viewer or editor, for --email. Default: viewer
  --message <text>     A note for the email`,
  login: `Usage: the-artifact login [options]

Signs in with the browser and saves the sign-in for this server. On a machine without a browser,
save an access token from Account settings → Access tokens instead:

  the-artifact login --with-token < token.txt

Options:
  --with-token    Read an access token from standard input and save it
  --no-browser    Print the sign-in link without opening a browser`,
  logout: `Usage: the-artifact logout [options]

Removes the saved sign-in for the server, and disconnects it on the server.`,
  whoami: `Usage: the-artifact whoami [options]

Shows the account and workspace the CLI publishes as, and checks that the sign-in still works.`,
}

const GLOBAL: ParseArgsConfig['options'] = {
  server: { type: 'string' },
  token: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

const OPTIONS: Record<string, ParseArgsConfig['options']> = {
  publish: {
    title: { type: 'string' },
    id: { type: 'string' },
    entry: { type: 'string' },
    visibility: { type: 'string' },
    folder: { type: 'string' },
    ignore: { type: 'string', multiple: true },
    only: { type: 'string', multiple: true },
    remove: { type: 'string', multiple: true },
    save: { type: 'boolean' },
    new: { type: 'boolean' },
    watch: { type: 'boolean' },
    poll: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  },
  list: { query: { type: 'string' }, folder: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' } },
  share: {
    visibility: { type: 'string' },
    expires: { type: 'string' },
    password: { type: 'string' },
    'new-link': { type: 'boolean' },
    email: { type: 'string', multiple: true },
    role: { type: 'string' },
    message: { type: 'string' },
  },
  login: { 'with-token': { type: 'boolean' }, 'no-browser': { type: 'boolean' } },
  logout: {},
  whoami: {},
}

type Values = Record<string, string | boolean | string[] | undefined>
export type Parsed = { command: string; positionals: string[]; values: Values }

export function parse(argv: string[]): Parsed | { help: string } | { version: true } {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    const topic = command === 'help' ? rest[0] : undefined
    return { help: (topic && COMMAND_HELP[topic]) || HELP }
  }
  if (command === '--version' || command === '-v' || command === 'version') return { version: true }
  const options = OPTIONS[command]
  if (!options) throw new UsageError(`"${command}" isn't a command. Run the-artifact --help to see them.`)
  let parsed: { values: Values; positionals: string[] }
  try {
    parsed = parseArgs({ args: rest, options: { ...GLOBAL, ...options }, allowPositionals: true, strict: true }) as typeof parsed
  } catch (err) {
    // parseArgs messages name the option, e.g. "Unknown option '--titel'"
    throw new UsageError(`${(err as Error).message.replace(/\. To specify a positional argument.*$/s, '')}. Run the-artifact ${command} --help.`)
  }
  if (parsed.values.help) return { help: COMMAND_HELP[command] }
  return { command, positionals: parsed.positionals, values: parsed.values }
}

const VISIBILITY: Record<string, string> = {
  restricted: 'private',
  private: 'private',
  organization: 'organization',
  org: 'organization',
  link: 'link',
}

const ACCESS_LABEL: Record<string, string> = { private: 'Restricted', organization: 'Organization', link: 'Anyone with the link' }

export function visibilityArg(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const v = VISIBILITY[value.trim().toLowerCase()]
  if (!v) throw new UsageError(`--visibility is restricted, organization or link, not "${value}".`)
  return v
}

function str(values: Values, key: string): string | undefined {
  const v = values[key]
  return typeof v === 'string' ? v : undefined
}

function one(positionals: string[], what: string, command: string): string {
  if (positionals.length === 0) throw new UsageError(`Say which ${what}: the-artifact ${command} <${what}>.`)
  if (positionals.length > 1) throw new UsageError(`${command} takes one ${what}, not ${positionals.length}. Quote paths with spaces.`)
  return positionals[0]
}

function print(io: Io, values: Values, json: unknown, human: string) {
  io.stdout.write(values.json ? `${JSON.stringify(json, null, 2)}\n` : human ? `${human}\n` : '')
}

function publishedLine(page: Published, extra = '') {
  return (
    `${page.version === 1 ? 'Published' : `Published version ${page.version} of`} "${page.title}" (${ACCESS_LABEL[page.visibility] ?? page.visibility}${page.folder ? `, in ${page.folder}` : ''}).` +
    extra
  )
}

// What publishing `target` sends, with its title
async function readTarget(target: string, given: string, values: Values) {
  const collected = await collectPage(target, { entry: str(values, 'entry'), ignore: values.ignore as string[] | undefined, label: given })
  checkLimits(collected)
  const { html, files } = await readPage(collected)
  const title = str(values, 'title')?.trim() || titleFromHtml(html.toString('utf8')) || fallbackTitle(target, collected.isDir)
  return { collected, html, files, title }
}

function describePage(collected: { files: unknown[]; total: number }) {
  const count = collected.files.length
  return `${count ? `index.html and ${count} ${count === 1 ? 'file' : 'files'}` : 'index.html'}, ${formatBytes(collected.total)}`
}

// The page --id names, or the one .the-artifact.json remembers for this path on this server
async function pageToPublish(io: Io, values: Values, target: string, server: string): Promise<string | undefined> {
  // An empty --id is a new page, so CI can pass --id "$PAGE_ID" before the first run has set it
  const idArg = str(values, 'id')?.trim() || undefined
  const link = values.new || idArg ? null : await readLink(io.cwd, target)
  return idArg ?? (link && link.server === server ? link.id : undefined)
}

async function publish(io: Io, parsed: Parsed) {
  const { positionals, values } = parsed
  const partial = Boolean((values.only as string[] | undefined)?.length || (values.remove as string[] | undefined)?.length)
  if (partial && values.watch) throw new UsageError("--watch publishes the whole folder, so it doesn't go with --only or --remove.")
  if (partial) return update(io, parsed)
  const given = one(positionals, 'folder', 'publish')
  const target = resolve(io.cwd, given)
  const visibility = visibilityArg(str(values, 'visibility'))
  if (values.watch && values['dry-run']) throw new UsageError("--watch and --dry-run don't go together.")
  if (values.poll && !values.watch) throw new UsageError('--poll goes with --watch.')
  if (values.watch) return watchAndPublish(io, values, given, target, visibility)
  const { collected, html, files, title } = await readTarget(target, given, values)
  const log = (line: string) => io.stderr.write(`${line}\n`)
  for (const s of collected.skipped) log(`Left out ${s.path}: ${s.reason}.`)

  if (values['dry-run']) {
    const lines = [
      `${collected.entry.path} (the page, ${formatBytes(collected.entry.size)})`,
      ...collected.files.map((f) => `${f.path} (${formatBytes(f.size)})`),
    ]
    print(
      io,
      values,
      { title, entry: collected.entry.path, files: collected.files.map((f) => ({ path: f.path, size: f.size })), total: collected.total },
      `Title: ${title}\n${lines.join('\n')}\n${1 + collected.files.length} files, ${formatBytes(collected.total)}. Nothing was sent.`,
    )
    return
  }

  const server = await resolveServer(str(values, 'server'), io.env)
  const auth = await resolveAuth(server, { token: str(values, 'token'), env: io.env })
  const id = await pageToPublish(io, values, target, server)
  log(`${id ? 'Publishing a new version of' : 'Publishing'} "${title}": ${describePage(collected)}.`)

  const page = await publishPage(auth, { title, html, files, id, visibility, folder: str(values, 'folder') })
  if (values.save) await saveLink(io.cwd, target, { id: page.id, server })
  log(publishedLine(page, values.save ? ` Saved in ${LINK_FILE}; publishing this path again updates it.` : ''))
  // The link alone on stdout, so `url=$(the-artifact publish dist)` works
  print(io, values, page, page.url)
}

// publish --only/--remove: a new version of an existing page with only some files sent or removed,
// and the rest of its current version kept (mode update of POST /api/publish)
async function update(io: Io, { positionals, values }: Parsed) {
  const given = one(positionals, 'folder', 'publish')
  const target = resolve(io.cwd, given)
  const visibility = visibilityArg(str(values, 'visibility'))
  const only = (values.only as string[] | undefined) ?? []
  const remove = ((values.remove as string[] | undefined) ?? []).map((p) => p.trim().replace(/^\.\//, '')).filter(Boolean)
  if (values.new) throw new UsageError("--only and --remove change a page you have, so they don't go with --new.")
  const some = only.length
    ? await collectSome(target, only, { entry: str(values, 'entry'), ignore: values.ignore as string[] | undefined, label: given })
    : { entry: null, files: [], skipped: [], total: 0 }
  checkLimits(some)
  const log = (line: string) => io.stderr.write(`${line}\n`)
  for (const s of some.skipped) log(`Left out ${s.path}: ${s.reason}.`)
  const sent = [...(some.entry ? [{ path: ENTRY_PATH, abs: some.entry.abs, size: some.entry.size }] : []), ...some.files]
  if (!sent.length && !remove.length) throw new CliError(`Nothing in ${given} matches --only, so there is nothing to send.`)
  const title = str(values, 'title')?.trim() || undefined

  if (values['dry-run']) {
    const lines = [...sent.map((f) => `${f.path} (${formatBytes(f.size)})`), ...remove.map((p) => `${p} (removed)`)]
    print(
      io,
      values,
      { title: title ?? null, files: sent.map((f) => ({ path: f.path, size: f.size })), remove, total: some.total },
      `${title ? `Title: ${title}\n` : ''}${lines.join('\n')}\n${sent.length} ${sent.length === 1 ? 'file' : 'files'}, ${formatBytes(some.total)}; the page's other files stay as they are. Nothing was sent.`,
    )
    return
  }

  const server = await resolveServer(str(values, 'server'), io.env)
  const auth = await resolveAuth(server, { token: str(values, 'token'), env: io.env })
  const idArg = str(values, 'id')?.trim() || undefined
  const link = idArg ? null : await readLink(io.cwd, target)
  const id = idArg ?? (link && link.server === server ? link.id : undefined)
  if (!id) throw new UsageError('--only and --remove update a page you published before: pass its --id, or publish it once with --save.')
  const parts = [sent.length ? `${sent.map((f) => f.path).join(', ')} (${formatBytes(some.total)})` : '', remove.length ? `removing ${remove.join(', ')}` : '']
  log(`Updating ${id}: ${parts.filter(Boolean).join('; ')}.`)

  const html = some.entry ? await readFile(some.entry.abs) : undefined
  const files = await Promise.all(some.files.map(async (f) => ({ path: f.path, content: await readFile(f.abs) })))
  const page = await publishPage(auth, { title, html, files, id, visibility, folder: str(values, 'folder'), update: { remove } })
  if (values.save) await saveLink(io.cwd, target, { id: page.id, server })
  log(
    `Published version ${page.version} of "${page.title}" (${ACCESS_LABEL[page.visibility] ?? page.visibility}${page.folder ? `, in ${page.folder}` : ''}); its other files are as they were.` +
      (values.save ? ` Saved in ${LINK_FILE}; publishing this path again updates it.` : ''),
  )
  print(io, values, page, page.url)
}

// Publishes, then again whenever the folder changes, until Ctrl+C. Every publish after the first is a
// new version of the same page, and a failed one is reported without ending the watch.
async function watchAndPublish(io: Io, values: Values, given: string, target: string, visibility: string | undefined) {
  const info = await stat(target).catch(() => null)
  if (!info) throw new CliError(`There is no file or folder at ${given}.`)
  const server = await resolveServer(str(values, 'server'), io.env)
  const auth = await resolveAuth(server, { token: str(values, 'token'), env: io.env })
  const log = (line: string) => io.stderr.write(`${line}\n`)
  const state = {
    id: await pageToPublish(io, values, target, server),
    published: false,
    // Direct uploads send only the files the server doesn't have yet. Decided on the first publish.
    uploads: null as boolean | null,
    fingerprint: '',
    skipped: '',
  }

  async function publishOnce() {
    const { collected, html, files, title } = await readTarget(target, given, values)
    const skipped = collected.skipped.map((s) => `Left out ${s.path}: ${s.reason}.`).join('\n')
    if (skipped && skipped !== state.skipped) log(skipped)
    state.skipped = skipped
    // Saving a file without changing it, or touching it, publishes nothing
    const hash = createHash('sha256').update(title).update('\0').update(html)
    for (const f of files) hash.update('\0').update(f.path).update('\0').update(f.content)
    const fingerprint = hash.digest('hex')
    if (state.published && fingerprint === state.fingerprint) return

    // Visibility and folder go with the first publish only, so changing them in the app meanwhile sticks
    const page: PageContent = { title, html, files, id: state.id }
    if (!state.published) Object.assign(page, { visibility, folder: str(values, 'folder') })
    log(`${state.id ? 'Publishing a new version of' : 'Publishing'} "${title}": ${describePage(collected)}.`)
    state.uploads ??= await canUpload(auth).catch(() => false)
    let result: Published & { uploaded?: number }
    if (state.uploads) {
      try {
        result = await publishByUpload(auth, page)
      } catch (err) {
        if (!(err instanceof StorageUnreachable)) throw err
        log(`${err.message} Sending whole pages instead.`)
        state.uploads = false
        result = await publishPage(auth, page)
      }
    } else result = await publishPage(auth, page)

    const first = !state.published
    state.id = result.id
    state.published = true
    state.fingerprint = fingerprint
    if (first && values.save) await saveLink(io.cwd, target, { id: result.id, server })
    const total = 1 + files.length
    const sent = result.uploaded !== undefined && result.uploaded < total ? ` Sent ${result.uploaded} of ${total} files; the others were already stored.` : ''
    log(publishedLine(result, sent + (first && values.save ? ` Saved in ${LINK_FILE}.` : '')))
    // One line per version: the link, or with --json one JSON object
    io.stdout.write(values.json ? `${JSON.stringify(result)}\n` : `${result.url}\n`)
  }

  const signal = io.interrupted?.() ?? new AbortController().signal
  const stop = new AbortController()
  let fatal: unknown = null
  // A refused sign-in won't fix itself, so it ends the watch; anything else waits for the next change
  const report = (err: unknown) => {
    if (err instanceof SignedOutError) {
      fatal = err
      stop.abort()
    } else if (err instanceof CliError) log(err.message)
    else log(`Something went wrong: ${(err as Error)?.stack ?? err}`)
  }

  try {
    await publishOnce()
  } catch (err) {
    report(err)
    if (fatal) throw fatal
  }
  const file = info.isFile() ? basename(target) : undefined
  const root = file === undefined ? target : dirname(target)
  const relevant = relevantChange({ file, ignore: values.ignore as string[] | undefined })
  const subscribe = io.watch?.subscribe?.(root, relevant) ?? watchFolder(root, { file, relevant, poll: Boolean(values.poll), log })
  log(`Watching ${given} for changes. Press Ctrl+C to stop.`)
  signal.addEventListener('abort', () => stop.abort(), { once: true })
  if (signal.aborted) stop.abort()
  await runWatch({ subscribe, relevant, signal: stop.signal, clock: io.watch?.clock, debounceMs: io.watch?.debounceMs, publish: publishOnce, onError: report })
  if (fatal) throw fatal
  log('Stopped watching.')
}

type Listed = {
  pages: { id: string; title: string; url: string; version: number; visibility: string; folder: string | null; updated_at: string }[]
  total: number | null
  cursor: string | null
}

async function list(io: Io, { positionals, values }: Parsed) {
  if (positionals.length) throw new UsageError('list takes no arguments. Use --query to search titles.')
  const limitText = str(values, 'limit')
  const limit = limitText === undefined ? undefined : Number(limitText)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new UsageError('--limit is a number from 1 to 100.')
  const server = await resolveServer(str(values, 'server'), io.env)
  const auth = await resolveAuth(server, { token: str(values, 'token'), env: io.env })
  const args: Record<string, unknown> = {}
  for (const key of ['query', 'folder', 'cursor']) if (str(values, key) !== undefined) args[key] = str(values, key)
  if (limit !== undefined) args.limit = limit
  const { text, structured } = await callTool(auth, 'list_artifacts', args)
  const listed = structured as Listed | undefined
  // A server from before list_artifacts answered with data: show what it says
  if (!listed?.pages) {
    if (values.json) throw new CliError(`${server} is too old for list --json. Update it, or leave out --json.`)
    io.stdout.write(`${text}\n`)
    return
  }
  if (values.json) {
    print(io, values, listed, '')
    return
  }
  if (listed.pages.length === 0) {
    const narrowed = args.query !== undefined || args.folder !== undefined
    io.stderr.write(args.cursor ? 'No more pages.\n' : narrowed ? 'No pages match.\n' : 'No pages yet.\n')
    return
  }
  const rows = listed.pages.map((p) => [p.id, `v${p.version}`, ACCESS_LABEL[p.visibility] ?? p.visibility, p.folder ?? '', p.title])
  const header = ['ID', 'VERSION', 'ACCESS', 'FOLDER', 'TITLE']
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (r: string[]) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i])))
      .join('  ')
      .trimEnd()
  io.stdout.write(`${[header, ...rows].map(line).join('\n')}\n`)
  if (listed.total !== null && listed.total > listed.pages.length) io.stderr.write(`${listed.pages.length} of ${listed.total} pages.\n`)
  if (listed.cursor) io.stderr.write(`For the next ones: the-artifact list --cursor ${listed.cursor}\n`)
}

async function share(io: Io, { positionals, values }: Parsed) {
  const page = one(positionals, 'page', 'share')
  const visibility = visibilityArg(str(values, 'visibility'))
  const emails = ((values.email as string[] | undefined) ?? [])
    .flatMap((e) => e.split(','))
    .map((e) => e.trim())
    .filter(Boolean)
  const role = str(values, 'role')
  if (role !== undefined && role !== 'viewer' && role !== 'editor') throw new UsageError('--role is viewer or editor.')
  if ((role !== undefined || str(values, 'message') !== undefined) && emails.length === 0) throw new UsageError('--role and --message go with --email.')
  const link: Record<string, unknown> = {}
  if (visibility) link.visibility = visibility
  if (str(values, 'expires') !== undefined) link.link_expires = str(values, 'expires')
  if (str(values, 'password') !== undefined) link.link_password = str(values, 'password')
  if (values['new-link']) link.rotate_link = true
  if (Object.keys(link).length === 0 && emails.length === 0)
    throw new UsageError('Say what to change: --visibility restricted|organization|link, --expires, --password, --new-link, or --email someone@example.com.')
  const server = await resolveServer(str(values, 'server'), io.env)
  const auth = await resolveAuth(server, { token: str(values, 'token'), env: io.env })
  const messages: string[] = []
  if (Object.keys(link).length) messages.push((await callTool(auth, 'set_artifact_visibility', { artifact_id: page, ...link })).text)
  if (emails.length) {
    const args: Record<string, unknown> = { artifact_id: page, emails, role: role ?? 'viewer' }
    if (str(values, 'message') !== undefined) args.message = str(values, 'message')
    messages.push((await callTool(auth, 'share_artifact', args)).text)
  }
  print(io, values, { messages }, messages.join('\n'))
}

async function login(io: Io, { positionals, values }: Parsed) {
  if (positionals.length) throw new UsageError('login takes no arguments. Pass the server with --server.')
  const server = await resolveServer(str(values, 'server'), io.env)
  let saved: Saved
  if (values['with-token'] || str(values, 'token')) {
    const token = (str(values, 'token') ?? (await io.readStdin())).trim()
    if (!token) throw new UsageError('Pipe the access token in: the-artifact login --with-token < token.txt')
    saved = { kind: 'token', token }
  } else {
    saved = await browserLogin(server, { open: io.openBrowser && !values['no-browser'], log: (line) => io.stderr.write(`${line}\n`) })
  }
  // Checks the new token before saving it, and shows whose it is
  const probe = saved
  const me = await whoami({
    server,
    source: 'saved',
    kind: probe.kind,
    bearer: async () => (probe.kind === 'oauth' ? probe.accessToken : probe.token),
    renew: async () => false,
  }).catch((err) => {
    if (probe.kind === 'token' && err instanceof SignedOutError) throw new CliError(`${server} refused that access token. It may have expired or been revoked.`)
    throw err
  })
  await updateCredentials(io.env, (c) => {
    c.servers[server] = saved
    c.default = server
  })
  print(io, values, { server, ...me }, `Signed in to ${server} as ${me.email}, publishing to ${me.workspace.name}.`)
  if (io.env.THE_ARTIFACT_TOKEN) io.stderr.write('THE_ARTIFACT_TOKEN is set, and is used instead of this sign-in until you unset it.\n')
}

async function logout(io: Io, { positionals, values }: Parsed) {
  if (positionals.length) throw new UsageError('logout takes no arguments. Pass the server with --server.')
  const creds = await readCredentials(io.env)
  const server = str(values, 'server') ? normalizeServer(str(values, 'server')!) : await resolveServer(undefined, io.env)
  const saved = creds.servers[server]
  if (saved) {
    await revoke(server, saved)
    await updateCredentials(io.env, (c) => {
      delete c.servers[server]
      if (c.default === server) c.default = Object.keys(c.servers)[0]
    })
  }
  print(io, values, { server, signedOut: Boolean(saved) }, saved ? `Signed out of ${server}.` : `You weren't signed in to ${server}.`)
  if (io.env.THE_ARTIFACT_TOKEN) io.stderr.write('THE_ARTIFACT_TOKEN is still set; unset it to stop using that token.\n')
}

async function whoamiCommand(io: Io, { positionals, values }: Parsed) {
  if (positionals.length) throw new UsageError('whoami takes no arguments.')
  const server = await resolveServer(str(values, 'server'), io.env)
  const auth = await resolveAuth(server, { token: str(values, 'token'), env: io.env })
  const me = await whoami(auth)
  const via = auth.source === 'env' ? ' (THE_ARTIFACT_TOKEN)' : auth.source === 'flag' ? ' (--token)' : ''
  print(io, values, { server, ...me }, `${me.email} in ${me.workspace.name} on ${server}${via}`)
}

const COMMANDS: Record<string, (io: Io, parsed: Parsed) => Promise<void>> = { publish, list, share, login, logout, whoami: whoamiCommand }

// Runs one command line and gives the exit code: 0 done, 1 failed, 2 wrong usage
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const parsed = parse(argv)
    if ('help' in parsed) {
      io.stdout.write(`${parsed.help}\n`)
      return 0
    }
    if ('version' in parsed) {
      io.stdout.write(`${VERSION}\n`)
      return 0
    }
    await COMMANDS[parsed.command](io, parsed)
    return 0
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`${err.message}\n`)
      return err.exitCode
    }
    io.stderr.write(`Something went wrong: ${(err as Error)?.stack ?? err}\n`)
    return 1
  }
}
