import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown.js'

// Smoke tests only -- these check the shape of the React element tree
// (createElement output), not rendered DOM, since no DOM-testing library is
// wired up for web/ yet and pulling one in just for this would be
// disproportionate to a hand-rolled renderer this small.

function blocksOf(tree) {
  return tree.props.children
}

describe('renderMarkdown', () => {
  it('returns null for empty input', () => {
    expect(renderMarkdown('')).toBe(null)
    expect(renderMarkdown(null)).toBe(null)
  })

  it('renders a header, a paragraph, and a bullet list as distinct blocks', () => {
    const tree = renderMarkdown('# Course summary\n\nKevin is doing fine.\n\n- Topic one\n- Topic two')
    const blocks = blocksOf(tree)
    expect(blocks).toHaveLength(3)
    expect(blocks[0].type).toBe('h3')
    expect(blocks[1].type).toBe('p')
    expect(blocks[2].type).toBe('ul')
    expect(blocks[2].props.children).toHaveLength(2)
  })

  it('renders bold text as a strong element, never raw asterisks', () => {
    const tree = renderMarkdown('This is **very important** context.')
    const paragraph = blocksOf(tree)[0]
    const inline = paragraph.props.children
    const strongNode = inline.find((node) => node && node.type === 'strong')
    expect(strongNode).toBeTruthy()
    expect(strongNode.props.children).toBe('very important')
  })

  it('maps ## and ### headers to distinct heading levels', () => {
    const tree = renderMarkdown('## Second level\n### Third level')
    const blocks = blocksOf(tree)
    expect(blocks[0].type).toBe('h4')
    expect(blocks[1].type).toBe('h5')
  })
})
