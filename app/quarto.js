// Quarto (.qmd, .rmd) syntax the preview page doesn't know, rewritten into
// markdown it does. Line numbers are kept, so scroll sync still lines up.
//
// - Code chunks ```{python echo=false} become ```python, so they're
//   highlighted and ```{mermaid} / ```{dot} are drawn. Chunk options (#| ...)
//   are hidden, as in rendered Quarto; blank lines after the chunk make up
//   the line count.
// - Callouts ::: {.callout-note title="..."} become GitHub admonitions
//   (> [!NOTE] ...), titled by title= or a heading on their first line.
// - Other ::: divs ({.response}, {.columns}, ...) become <div>s with those
//   classes, so a stylesheet can style them. ::: {#refs} is left for citations.js.
// - Bracketed spans [text]{.class} become <span>s; attributes after headings,
//   images and links ({.unnumbered}, {width=50%}) are hidden.
// - Stylesheets listed under `css:` in the front matter are applied, so the
//   preview looks like the document's HTML output.

const CALLOUTS = { note: 'NOTE', tip: 'TIP', important: 'IMPORTANT', warning: 'WARNING', caution: 'CAUTION' }
const FENCE = /^(\s*)(`{3,}|~{3,})\s*(.*)$/
const DIV = /^\s*(:{3,})\s*(\{[^}]*\}|[\w-]+)?\s*$/

const fs = require('fs')
const path = require('path')

const isQuarto = (name) => /\.(qmd|rmd)$/i.test(name || '')

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

// "{.a .b #id width="50%"}" -> ' id="id" class="a b" style="width: 50%"'
function htmlAttrs (attrs) {
  const inner = attrs.replace(/^\{|\}$/g, '')
  const classes = [...inner.matchAll(/(?:^|\s)\.([\w-]+)/g)].map((m) => m[1])
  const id = (inner.match(/(?:^|\s)#([\w:.-]+)/) || [])[1]
  const width = (inner.match(/width\s*=\s*"?([\d.]+(?:%|px|em|rem)?)"?/) || [])[1]
  const style = (inner.match(/style\s*=\s*"([^"]*)"/) || [])[1]
  const styles = [style, width && `flex: 0 0 ${width}; width: ${width}`].filter(Boolean).join('; ')
  return (id ? ` id="${escapeAttr(id)}"` : '') +
    (classes.length ? ` class="${escapeAttr(classes.join(' '))}"` : '') +
    (styles ? ` style="${escapeAttr(styles)}"` : '')
}

// Spans and attributes in a line of prose (code spans are left alone).
function inline (line) {
  return line.split(/(`+[^`]*`+)/).map((part, i) => {
    if (i % 2) return part
    return part
      // [text]{.class} -> <span class="class">text</span> (not links: those have ](...))
      .replace(/\[([^\[\]]*)\]\{([^{}]*)\}/g, (m, text, attrs) =>
        /[.#=]/.test(attrs) ? `<span${htmlAttrs(attrs)}>${text}</span>` : m)
      // ![alt](src){width=50%} and [text](url){...}: drop the attributes
      .replace(/(\]\([^()]*\))\{[^{}]*\}/g, '$1')
  }).join('')
}

// Stylesheets from the front matter's css: keys, as one <style> line.
function stylesheets (lines, end, name) {
  const files = []
  let inCss = false
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^\s*css:\s*(.*)$/)
    if (m) {
      inCss = !m[1].trim()
      if (m[1].trim()) files.push(...m[1].replace(/^\[|\]$/g, '').split(','))
      continue
    }
    const item = inCss && line.match(/^\s+-\s+(.*)$/)
    if (item) files.push(item[1])
    else if (!/^\s*$/.test(line)) inCss = false
  }
  const dir = path.dirname(name)
  const css = files.map((f) => f.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean)
    .map((f) => path.resolve(dir, f))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')
  return css ? `<style>${css.replace(/<\/style/gi, '').replace(/\s*\n\s*/g, ' ')}</style>` : null
}

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

  let frontEnd = 0
  const quoteDepth = () => divs.filter((d) => d.callout).length
  const prefix = () => '> '.repeat(quoteDepth())

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // YAML front matter passes through untouched.
    if (i === 0 && line === '---') {
      const end = lines.findIndex((l, j) => j > 0 && (l === '---' || l === '...'))
      if (end > 0) {
        frontEnd = end
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
        if (callout) {
          out.push(prefix() + `> [!${callout.type}]` + (callout.title ? ` ${callout.title}` : ''))
          divs.push({ colons: d[1].length, callout, titled: !!callout.title })
          continue
        }
        // Markdown inside an HTML block is only parsed after a blank line, so
        // the opening tag goes on the blank line before the div when there is one.
        const tag = prefix() + `<div${htmlAttrs(attrs)}>`
        if (out.length && out[out.length - 1].trim() === prefix().trim()) {
          out[out.length - 1] = tag
          out.push(prefix().trimEnd())
        } else {
          out.push(tag)
        }
        divs.push({ colons: d[1].length, html: true })
        continue
      }
      // A bare ::: closes the innermost div.
      const div = divs.pop()
      if (div && div.refs) {
        out.push(line)
      } else if (div && div.html) {
        out.push(prefix() + '</div>')
      } else {
        out.push(prefix().trimEnd())
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
    // Heading attributes: ## R1.1 {.unnumbered} -> ## R1.1
    const text = inline(line.replace(/^(\s*#{1,6}\s+.*?)\s+\{[^{}]*\}\s*$/, '$1'))
    out.push(quoteDepth() ? prefix() + text : text)
  }
  const style = name && stylesheets(lines, frontEnd, name)
  if (style) out.push('', style) // after the last line, so line numbers don't move
  return out
}

module.exports = { render }
