// Quarto (.qmd, .rmd) syntax the preview page doesn't know, rewritten into
// markdown it does. Line numbers are kept, so scroll sync still lines up.
//
// - Code chunks ```{python echo=false} become ```python, so they're
//   highlighted and ```{mermaid} / ```{dot} are drawn. Chunk options (#| ...)
//   are hidden, as in rendered Quarto; blank lines after the chunk make up
//   the line count.
// - Callouts ::: {.callout-note title="..."} become GitHub admonitions
//   (> [!NOTE] ...), titled by title= or a heading on their first line.
// - Other ::: divs lose their markers and keep their content. ::: {#refs} is
//   left for citations.js.

const CALLOUTS = { note: 'NOTE', tip: 'TIP', important: 'IMPORTANT', warning: 'WARNING', caution: 'CAUTION' }
const FENCE = /^(\s*)(`{3,}|~{3,})\s*(.*)$/
const DIV = /^\s*(:{3,})\s*(\{[^}]*\}|[\w-]+)?\s*$/

const isQuarto = (name) => /\.(qmd|rmd)$/i.test(name || '')

// "{python echo=false}" -> "python", "{.r}" -> "r", "python" -> "python"
function chunkLanguage (info) {
  const m = info.match(/^\{\s*\.?([\w+-]+)/)
  return m ? m[1] : null
}

function calloutOf (attrs) {
  const m = (attrs || '').match(/\.callout-(\w+)/)
  if (!m) return null
  const title = (attrs.match(/title\s*=\s*"([^"]*)"/) || attrs.match(/title\s*=\s*'([^']*)'/) || [])[1]
  return { type: CALLOUTS[m[1].toLowerCase()] || 'NOTE', title }
}

function render (lines, name) {
  if (!isQuarto(name)) return lines
  const out = []
  let fence = null // open code fence: { mark, chunk, hidden }
  const divs = [] // open ::: divs, innermost last: { colons, callout, titled }

  const quoteDepth = () => divs.filter((d) => d.callout).length
  const prefix = () => '> '.repeat(quoteDepth())

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // YAML front matter passes through untouched.
    if (i === 0 && line === '---') {
      const end = lines.findIndex((l, j) => j > 0 && (l === '---' || l === '...'))
      if (end > 0) {
        for (; i <= end; i++) out.push(lines[i])
        i = end
        continue
      }
    }

    const f = line.match(FENCE)
    if (fence) {
      if (f && f[2][0] === fence.mark[0] && f[2].length >= fence.mark.length && !f[3]) {
        out.push(prefix() + line)
        for (let k = 0; k < fence.hidden; k++) out.push('')
        fence = null
      } else if (fence.chunk && fence.options && /^\s*#\|/.test(line)) {
        fence.hidden++ // chunk option: hidden, made up after the fence
      } else {
        if (fence.chunk && !/^\s*#\|/.test(line)) fence.options = false
        out.push(prefix() + line)
      }
      continue
    }
    if (f) {
      const lang = chunkLanguage(f[3].trim())
      fence = { mark: f[2], chunk: !!lang, options: true, hidden: 0 }
      out.push(prefix() + (lang ? `${f[1]}${f[2]}${lang}` : line))
      continue
    }

    const d = line.match(DIV)
    if (d) {
      const attrs = d[2] || ''
      if (/#refs\b/.test(attrs)) {
        out.push(line) // citations.js puts the reference list here
        divs.push({ colons: d[1].length, refs: true })
        continue
      }
      if (attrs) {
        const callout = calloutOf(attrs)
        out.push(callout ? prefix() + `> [!${callout.type}]` + (callout.title ? ` ${callout.title}` : '') : '')
        divs.push({ colons: d[1].length, callout, titled: !!(callout && callout.title) })
        continue
      }
      // A bare ::: closes the innermost div.
      const div = divs.pop()
      if (div && div.refs) {
        out.push(line)
      } else {
        out.push('')
      }
      continue
    }

    // First line of an untitled callout that's a heading: it becomes the title.
    const top = divs[divs.length - 1]
    if (top && top.callout && !top.titled && line.trim() !== '') {
      top.titled = true
      const heading = line.match(/^\s*#{1,6}\s+(.*)$/)
      if (heading) {
        const last = out.length - 1 - [...out].reverse().findIndex((l) => /\[!\w+\]/.test(l))
        out[last] = out[last].replace(/\[!(\w+)\].*$/, `[!$1] ${heading[1]}`)
        out.push(prefix().trimEnd())
        continue
      }
    }
    out.push(quoteDepth() ? prefix() + line : line)
  }
  return out
}

module.exports = { render }
