// Minimal hand-rolled markdown -> React renderer for the course profile's
// `summary_md`. No markdown library exists anywhere in web/package.json
// (see the audit before this file was added), and the prompt that produces
// `summary_md` (api/src/prompts/course-profile.md) only ever asks Claude
// for headers, bold text, and lists -- so a small dependency-free renderer
// covering exactly that is a better fit than pulling in a heavy new
// dependency for one panel.
//
// Supported: # / ## / ### headers, **bold**, "- " / "* " bullet lists,
// blank-line-separated paragraphs. Anything else renders as plain text --
// never as raw, un-rendered markdown syntax.

import { Fragment, createElement as h } from 'react'

function renderInline(text, keyPrefix) {
  // Splits on **bold** runs only -- the one inline construct the profile
  // prompt actually uses. Everything else in a line is plain text, never
  // partially-parsed HTML.
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((part) => part.length > 0)
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return h('strong', { key: `${keyPrefix}-${index}` }, part.slice(2, -2))
    }
    return h(Fragment, { key: `${keyPrefix}-${index}` }, part)
  })
}

function headerLevel(line) {
  const match = line.match(/^(#{1,3})\s+(.*)$/)
  if (!match) return null
  return { level: match[1].length, text: match[2] }
}

function isBulletLine(line) {
  return /^[-*]\s+/.test(line)
}

export function renderMarkdown(source) {
  if (!source || typeof source !== 'string') return null

  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let paragraphLines = []
  let listItems = []

  function flushParagraph() {
    if (paragraphLines.length === 0) return
    const text = paragraphLines.join(' ')
    blocks.push(h('p', { key: `p-${blocks.length}` }, renderInline(text, `p-${blocks.length}`)))
    paragraphLines = []
  }

  function flushList() {
    if (listItems.length === 0) return
    blocks.push(
      h(
        'ul',
        { key: `ul-${blocks.length}` },
        listItems.map((item, index) =>
          h('li', { key: `li-${blocks.length}-${index}` }, renderInline(item, `li-${blocks.length}-${index}`))
        )
      )
    )
    listItems = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (line.length === 0) {
      flushParagraph()
      flushList()
      continue
    }

    const header = headerLevel(line)
    if (header) {
      flushParagraph()
      flushList()
      const tag = header.level === 1 ? 'h3' : header.level === 2 ? 'h4' : 'h5'
      blocks.push(h(tag, { key: `h-${blocks.length}` }, renderInline(header.text, `h-${blocks.length}`)))
      continue
    }

    if (isBulletLine(line)) {
      flushParagraph()
      listItems.push(line.replace(/^[-*]\s+/, ''))
      continue
    }

    flushList()
    paragraphLines.push(line)
  }

  flushParagraph()
  flushList()

  return h(Fragment, null, blocks)
}
