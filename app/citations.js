// Pandoc-style citations in the preview, formatted the way Quarto/pandoc render
// them. A document opts in by naming a bibliography in its YAML front matter:
//
//   ---
//   bibliography: refs.bib        # or a list; paths are relative to the file
//   csl: apa.csl                  # optional citation style
//   ---
//
// [@key], [@a; @b, p. 4], [-@key] and @key are replaced by pandoc --citeproc's
// output, and the reference list is added at ::: {#refs} or the end. Needs
// pandoc on PATH; without it, or without a bibliography, content is unchanged.

const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const logger = require('./lib/util/logger')('app/citations')

// A citation key: starts with a word character; internal punctuation is allowed
// only between word characters, as in pandoc.
const KEY = String.raw`[\w](?:[\w]|[:.#$%&\-+?<>~/](?=[\w]))*`
// Quarto cross-references use the same syntax, so leave those alone.
const CROSSREF = /^(fig|tbl|sec|eq|lst|thm|lem|cor|prp|cnj|def|exm|exr)-/
const BRACKETED = new RegExp(String.raw`\[[^\[\]\n]*\](?![(\[])`, 'g')
const IN_BRACKET = new RegExp(String.raw`(?:^|[\s;\[])-?@(${KEY})`, 'g')
const NARRATIVE = new RegExp(String.raw`(?<![\w@\\/:.])@(${KEY})`, 'g')
const MARK = 'MKDPCITE'
const cache = new Map()

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2')

// bibliography, csl and the line after the front matter
function frontMatter (lines) {
  if (lines[0] !== '---') return null
  const end = lines.findIndex((l, i) => i > 0 && (l === '---' || l === '...'))
  if (end < 0) return null
  const meta = { bibliography: [], csl: null, citeproc: true, end: end + 1 }
  let key = null
  for (const line of lines.slice(1, end)) {
    const field = line.match(/^([\w-]+):\s*(.*)$/)
    const item = line.match(/^\s+-\s+(.*)$/)
    if (field) {
      key = field[1]
      const value = field[2].trim()
      if (key === 'bibliography' && value) {
        meta.bibliography = value.startsWith('[')
          ? value.slice(1, -1).split(',').map(unquote).filter(Boolean)
          : [unquote(value)]
      } else if (key === 'csl' && value) {
        meta.csl = unquote(value)
      } else if (key === 'citeproc' && value === 'false') {
        meta.citeproc = false
      }
    } else if (item && key === 'bibliography') {
      meta.bibliography.push(unquote(item[1]))
    }
  }
  return meta
}

const hasCitation = (text) =>
  [...text.matchAll(IN_BRACKET)].some((m) => !CROSSREF.test(m[1]))

// Calls fn(segment) for text outside code, returning the rewritten line.
function mapProse (line, fn) {
  return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : fn(part))).join('')
}

// Every citation in the document, in order, outside code blocks and code spans.
function findCitations (lines, start) {
  const found = []
  let fence = null
  for (let i = start; i < lines.length; i++) {
    const open = lines[i].match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null
      continue
    }
    if (open) { fence = open[1]; continue }
    mapProse(lines[i], (text) => {
      const bracketed = [...text.matchAll(BRACKETED)].filter((m) => hasCitation(m[0]))
      bracketed.forEach((m) => found.push(m[0]))
      const outside = bracketed.reduce((t, m) => t.replace(m[0], ' '.repeat(m[0].length)), text)
      for (const m of outside.matchAll(NARRATIVE)) {
        if (!CROSSREF.test(m[1])) found.push(m[0])
      }
      return text
    })
  }
  return found
}

function pandoc (input, args, cwd) {
  return new Promise((resolve) => {
    const child = execFile('pandoc', args, { cwd, timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        logger.error('pandoc: ', err.message)
        return resolve(null)
      }
      resolve(stdout)
    })
    child.stdin.end(input)
  })
}

const mtime = (file) => { try { return fs.statSync(file).mtimeMs } catch (e) { return 0 } }

async function format (citations, bibs, csl, cwd) {
  const key = JSON.stringify([citations, bibs.map((b) => [b, mtime(b)]), csl, csl && mtime(csl)])
  if (cache.has(key)) return cache.get(key)
  const input = citations.map((c, i) => `${MARK}${i} ${c}`).join('\n\n')
  const args = ['-f', 'markdown', '-t', 'html', '--citeproc', '--wrap=none']
  bibs.forEach((b) => args.push(`--bibliography=${b}`))
  if (csl) args.push(`--csl=${csl}`)
  const html = await pandoc(input, args, cwd)
  if (html === null) return null
  const result = { formatted: {}, refs: null }
  for (const m of html.matchAll(new RegExp(`<p>${MARK}(\\d+) ([\\s\\S]*?)</p>`, 'g'))) {
    result.formatted[citations[Number(m[1])]] = m[2]
  }
  const refs = html.match(/<div id="refs"[\s\S]*<\/div>/)
  result.refs = refs ? refs[0] : null
  if (cache.size > 50) cache.delete(cache.keys().next().value)
  cache.set(key, result)
  return result
}

async function render (lines, name) {
  try {
    const meta = frontMatter(lines)
    if (!meta || !meta.citeproc || meta.bibliography.length === 0) return lines
    const dir = name ? path.dirname(name) : process.cwd()
    const resolve = (p) => path.resolve(dir, p.replace(/^~(?=\/)/, process.env.HOME || '~'))
    const bibs = meta.bibliography.map(resolve).filter((b) => fs.existsSync(b))
    if (bibs.length === 0) return lines
    const csl = meta.csl && resolve(meta.csl)
    const citations = [...new Set(findCitations(lines, meta.end))]
    if (citations.length === 0) return lines
    const result = await format(citations, bibs, csl && fs.existsSync(csl) ? csl : null, dir)
    if (!result) return lines

    // Replace in place, so line numbers (and scroll sync) stay the same.
    let fence = null
    const out = lines.map((line, i) => {
      if (i < meta.end) return line
      const open = line.match(/^\s*(`{3,}|~{3,})/)
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null
        return line
      }
      if (open) { fence = open[1]; return line }
      return mapProse(line, (text) => {
        let rewritten = text.replace(BRACKETED, (m) => (hasCitation(m) && result.formatted[m]) || m)
        rewritten = rewritten.replace(NARRATIVE, (m, key) => (!CROSSREF.test(key) && result.formatted[m]) || m)
        return rewritten
      })
    })

    if (result.refs) {
      const refsDiv = out.findIndex((l) => /^:::+\s*\{#refs\}\s*$/.test(l))
      if (refsDiv >= 0) {
        const close = out.findIndex((l, i) => i > refsDiv && /^:::+\s*$/.test(l))
        // Keep the line count, so later lines still match the buffer.
        const count = (close > refsDiv ? close : refsDiv) - refsDiv + 1
        out.splice(refsDiv, count, result.refs, ...Array(count - 1).fill(''))
      } else {
        const titled = out.some((l) => /^#{1,6}\s+(references|bibliography)\s*$/i.test(l))
        out.push('', titled ? '' : '<h2 class="references-title">References</h2>', '', result.refs)
      }
    }
    return out
  } catch (e) {
    logger.error('citations: ', e)
    return lines
  }
}

module.exports = { render }
