import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkLimits,
  collectPage,
  collectSome,
  fallbackTitle,
  globToRegExp,
  ignoreMatcher,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  titleFromHtml,
} from '../src/files.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artifact-cli-files-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function tree(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), content)
  }
}

describe('titleFromHtml', () => {
  it('reads the <title>, decoding entities and collapsing spaces', () => {
    expect(titleFromHtml('<html><head><TITLE lang="en">\n  Q3 &amp; Q4\n  report &#8212; &#x1F4C8; </TITLE>')).toBe('Q3 & Q4 report — 📈')
    expect(titleFromHtml('<title>&lt;b&gt; &unknown; &quot;x&quot;</title>')).toBe('<b> &unknown; "x"')
  })

  it('is null without a title, or with an empty one', () => {
    expect(titleFromHtml('<h1>No title</h1>')).toBeNull()
    expect(titleFromHtml('<title>   </title>')).toBeNull()
    expect(titleFromHtml('<titled>x</titled>')).toBeNull()
  })

  it('keeps 200 characters at most', () => {
    expect(titleFromHtml(`<title>${'a'.repeat(300)}</title>`)).toHaveLength(200)
  })

  it('falls back to the folder or file name', () => {
    expect(fallbackTitle('/work/coverage', true)).toBe('coverage')
    expect(fallbackTitle('/work/report.html', false)).toBe('report')
  })
})

describe('ignore globs', () => {
  it('turns globs into expressions', () => {
    expect(globToRegExp('*.map').test('app.js.map')).toBe(true)
    expect(globToRegExp('*.map').test('js/app.js.map')).toBe(false)
    expect(globToRegExp('**/*.map').test('js/app.js.map')).toBe(true)
    expect(globToRegExp('**/*.map').test('app.js.map')).toBe(true)
    expect(globToRegExp('img/?.png').test('img/a.png')).toBe(true)
    expect(globToRegExp('a+b.(x)').test('a+b.(x)')).toBe(true)
  })

  it('matches names at any depth, and paths from the top when they have a slash', () => {
    const ignored = ignoreMatcher(['*.map', 'drafts/', 'img/raw/**', ' '])
    expect(ignored('app.js.map', false)).toBe(true)
    expect(ignored('js/app.js.map', false)).toBe(true)
    expect(ignored('drafts', true)).toBe(true)
    expect(ignored('drafts', false)).toBe(false)
    expect(ignored('img/raw/a.png', false)).toBe(true)
    expect(ignored('img/a.png', false)).toBe(false)
  })
})

describe('collectPage', () => {
  it('takes index.html and the files next to it, leaving out hidden files, node_modules and other types', async () => {
    await tree({
      'index.html': '<title>x</title>',
      'css/site.css': 'body{}',
      'img/logo.png': 'png',
      '.env': 'SECRET=1',
      '.git/config': 'x',
      'node_modules/lib/index.js': 'x',
      'js/app.js.map': '{}',
      'js/app.js': 'x',
      'js/app.js.gz': 'x',
      LICENSE: 'x',
    })
    const page = await collectPage(dir, { ignore: ['*.map'] })
    expect(page.entry).toMatchObject({ path: 'index.html', size: 16 })
    expect(page.files.map((f) => f.path)).toEqual(['css/site.css', 'img/logo.png', 'js/app.js'])
    expect(page.skipped).toEqual([
      { path: 'LICENSE', reason: 'not a type pages can hold' },
      { path: 'js/app.js.gz', reason: 'not a type pages can hold' },
    ])
    expect(page.total).toBe(16 + 6 + 3 + 1)
    expect(page.isDir).toBe(true)
  })

  it('takes another entry with --entry, and leaves out an index.html next to it', async () => {
    await tree({ 'report.html': '<h1>r</h1>', 'index.html': 'old', 'style.css': 'x' })
    const page = await collectPage(dir, { entry: './report.html' })
    expect(page.entry.path).toBe('report.html')
    expect(page.files.map((f) => f.path)).toEqual(['style.css'])
    expect(page.skipped).toEqual([{ path: 'index.html', reason: 'the page itself is report.html' }])
  })

  it('publishes a single HTML file on its own', async () => {
    await tree({ 'report.html': '<h1>r</h1>', 'other.css': 'x' })
    const page = await collectPage(join(dir, 'report.html'))
    expect(page).toMatchObject({ entry: { path: 'report.html' }, files: [], isDir: false })
  })

  it('follows links to files but not to folders', async () => {
    await tree({ 'index.html': 'x', 'shared/a.css': 'a' })
    await mkdir(join(dir, 'site'))
    await writeFile(join(dir, 'site/index.html'), 'x')
    await symlink(join(dir, 'shared/a.css'), join(dir, 'site/a.css'))
    await symlink(join(dir, 'shared'), join(dir, 'site/shared'))
    const page = await collectPage(join(dir, 'site'))
    expect(page.files.map((f) => f.path)).toEqual(['a.css'])
    expect(page.skipped).toEqual([{ path: 'shared', reason: 'a link to a folder' }])
  })

  it('says what is wrong with the path', async () => {
    await tree({ 'notes.txt': 'x', 'page.html': 'x' })
    await expect(collectPage(join(dir, 'missing'), { label: 'missing' })).rejects.toThrow('There is no file or folder at missing.')
    await expect(collectPage(dir, { label: 'dist' })).rejects.toThrow('There is no index.html in dist. Pass --entry')
    await expect(collectPage(dir, { entry: 'nope.html', label: 'dist' })).rejects.toThrow('There is no nope.html in dist.')
    await expect(collectPage(dir, { entry: 'notes.txt' })).rejects.toThrow("isn't an HTML file")
    await expect(collectPage(join(dir, 'notes.txt'), { label: 'notes.txt' })).rejects.toThrow("notes.txt isn't an HTML file")
    await expect(collectPage(join(dir, 'page.html'), { entry: 'x.html' })).rejects.toThrow('--entry is for publishing a folder')
  })
})

describe('collectSome', () => {
  it('takes only the files matching --only, by path or glob, without needing the rest of the page', async () => {
    await tree({ 'data.json': '{}', 'data/a.json': '1', 'data/b.json': '22', 'data/c.csv': 'x', 'app.js': 'x', 'data/run.sh': 'x', '.hidden.json': 'x' })
    const some = await collectSome(dir, ['./data.json', 'data/*.json', 'data/run.sh'])
    expect(some.entry).toBeNull()
    expect(some.files.map((f) => f.path)).toEqual(['data/a.json', 'data/b.json', 'data.json'])
    expect(some.skipped).toEqual([{ path: 'data/run.sh', reason: 'not a type pages can hold' }])
    expect(some.total).toBe(2 + 1 + 2)
  })

  it('sends the entry HTML as index.html, by its own name or as index.html', async () => {
    await tree({ 'report.html': '<h1>r</h1>', 'index.html': 'old', 'style.css': 'x' })
    expect((await collectSome(dir, ['index.html'])).entry?.path).toBe('index.html')
    const other = await collectSome(dir, ['index.html', 'report.html'], { entry: 'report.html' })
    expect(other.entry?.path).toBe('report.html')
    expect(other.skipped).toEqual([{ path: 'index.html', reason: 'the page itself is report.html' }])
    expect((await collectSome(join(dir, 'report.html'), ['index.html'])).entry?.path).toBe('report.html')
  })

  it('says which --only matched nothing', async () => {
    await tree({ 'data.json': '{}' })
    await expect(collectSome(dir, ['data.json', 'data.csv'], { label: 'dash' })).rejects.toThrow('Nothing in dash matches --only data.csv.')
    await expect(collectSome(join(dir, 'missing'), ['x'], { label: 'missing' })).rejects.toThrow('There is no file or folder at missing.')
  })
})

describe('checkLimits', () => {
  const entry = { path: 'index.html', abs: '', size: 10 }
  const file = (path: string, size: number) => ({ path, abs: '', size })

  it('passes a page within the limits', () => {
    expect(() => checkLimits({ entry, files: [file('a.css', 10)], total: 20 })).not.toThrow()
  })

  it('checks an update without the entry', () => {
    expect(() => checkLimits({ entry: null, files: [file('data.json', 10)], total: 10 })).not.toThrow()
    expect(() => checkLimits({ entry: null, files: [file('v.mp4', MAX_FILE_BYTES + 1)], total: MAX_FILE_BYTES + 1 })).toThrow('v.mp4 is larger')
  })

  it('refuses what the server would refuse, before sending it', () => {
    expect(() => checkLimits({ entry: { ...entry, size: 0 }, files: [], total: 0 })).toThrow('index.html is empty.')
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`${i}.css`, 1))
    expect(() => checkLimits({ entry, files: many, total: 200 })).toThrow('at most 100 files')
    expect(() => checkLimits({ entry, files: [file('v.mp4', MAX_FILE_BYTES + 1)], total: MAX_FILE_BYTES + 11 })).toThrow('v.mp4 is larger than 5 MB')
    expect(() => checkLimits({ entry, files: [], total: MAX_TOTAL_BYTES + 1 })).toThrow('more than 10 MB')
  })
})
