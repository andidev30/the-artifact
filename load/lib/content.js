import { randomBytes } from 'k6/crypto'
import encoding from 'k6/encoding'

function filler(bytes, line) {
  const parts = []
  let size = 0
  for (let n = 0; size < bytes; n++) {
    const s = line(n)
    parts.push(s)
    size += s.length + 1
  }
  return parts.join('\n')
}

// A page like an agent sends to publish_artifact: HTML of about htmlKb, plus `files` files of about
// fileKb each, every third one binary (base64 in the request, as MCP clients send images)
export function makeSite({ htmlKb, files, fileKb, title }) {
  const refs = []
  const list = []
  for (let i = 0; i < files; i++) {
    const kind = i % 3 === 2 ? 'png' : i % 3 === 1 ? 'css' : 'js'
    const path = `${kind === 'png' ? 'img' : kind}/f${i}.${kind}`
    if (kind === 'png') {
      list.push({ path, content: encoding.b64encode(randomBytes(fileKb * 1024)), encoding: 'base64' })
      refs.push(`<img src="${path}" alt="">`)
    } else if (kind === 'css') {
      list.push({ path, content: filler(fileKb * 1024, (n) => `.r${i}-${n} { padding: ${n % 24}px; border-radius: ${n % 9}px; }`) })
      refs.push(`<link rel="stylesheet" href="${path}">`)
    } else {
      list.push({ path, content: filler(fileKb * 1024, (n) => `export const v${i}_${n} = (x) => x * ${n} + ${i}`) })
      refs.push(`<script type="module" src="${path}"></script>`)
    }
  }
  const body = filler(htmlKb * 1024, (n) => `<section><h2>Section ${n}</h2><p>Numbers for week ${n % 52}: ${(n * 7919) % 10007} signups.</p></section>`)
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${refs.join('')}</head><body><h1>${title}</h1>\n${body}\n</body></html>`
  return { html, files: list }
}

// Content-addressed storage keeps one copy of identical bytes, so a publish that repeats an earlier
// one is cheaper than a new page. This makes the HTML (and optionally every text file) new each time.
export function unique(site, nonce, allFiles) {
  const mark = `<!-- ${nonce} -->`
  return {
    html: site.html.replace('</body>', `${mark}</body>`),
    files: allFiles ? site.files.map((f) => (f.encoding === 'base64' ? f : { ...f, content: `${f.content}\n/* ${nonce} */` })) : site.files,
  }
}
