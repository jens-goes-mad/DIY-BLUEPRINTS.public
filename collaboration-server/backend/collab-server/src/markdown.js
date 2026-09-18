import { MarkdownSerializer, MarkdownParser } from 'prosemirror-markdown'
import MarkdownIt from 'markdown-it'

function listIsTight(tokens, i) {
  while (++i < tokens.length) {
    if (tokens[i].type !== 'list_item_open') return tokens[i].hidden
  }
  return false
}

export function createMarkdownSerializer() {
  return new MarkdownSerializer({
    blockquote(state, node) {
      state.wrapBlock('> ', null, node, () => state.renderContent(node))
    },
    codeBlock(state, node) {
      const backticks = node.textContent.match(/`{3,}/gm)
      const fence = backticks ? (backticks.sort().slice(-1)[0] + '`') : '```'
      state.write(fence + (node.attrs.language || '') + '\n')
      state.text(node.textContent, false)
      state.write('\n')
      state.write(fence)
      state.closeBlock(node)
    },
    heading(state, node) {
      state.write(state.repeat('#', node.attrs.level) + ' ')
      state.renderInline(node, false)
      state.closeBlock(node)
    },
    horizontalRule(state, node) {
      state.write(node.attrs.markup || '---')
      state.closeBlock(node)
    },
    bulletList(state, node) {
      state.renderList(node, '  ', () => (node.attrs.bullet || '-') + ' ')
    },
    orderedList(state, node) {
      const start = node.attrs.start || 1
      const maxW = String(start + node.childCount - 1).length
      const space = state.repeat(' ', maxW + 2)
      state.renderList(node, space, i => {
        const nStr = String(start + i)
        return state.repeat(' ', maxW - nStr.length) + nStr + '. '
      })
    },
    listItem(state, node) {
      state.renderContent(node)
    },
    paragraph(state, node) {
      state.renderInline(node)
      state.closeBlock(node)
    },
    hardBreak(state, node, parent, index) {
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write('\\\n')
          return
        }
      }
    },
    text(state, node) {
      state.text(node.text, !state.inAutolink)
    },
  }, {
    italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
    bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    code: {
      open(_state, _mark, parent, index) { return backticksFor(parent.child(index), -1) },
      close(_state, _mark, parent, index) { return backticksFor(parent.child(index - 1), 1) },
      escape: false,
    },
  }, {
    hardBreakNodeName: 'hardBreak',
  })
}

function backticksFor(node, side) {
  const ticks = /`+/g
  let m
  let len = 0
  if (node.isText) {
    while ((m = ticks.exec(node.text))) len = Math.max(len, m[0].length)
  }
  let result = len > 0 && side > 0 ? ' `' : '`'
  for (let i = 0; i < len; i++) result += '`'
  if (len > 0 && side < 0) result += ' '
  return result
}

export function createMarkdownParser(schema) {
  const tokenizer = new MarkdownIt('default', { html: false })
  return new MarkdownParser(schema, tokenizer, {
    blockquote: { block: 'blockquote' },
    paragraph: { block: 'paragraph' },
    list_item: { block: 'listItem' },
    bullet_list: { block: 'bulletList', getAttrs: (_, tokens, i) => ({ tight: listIsTight(tokens, i) }) },
    ordered_list: {
      block: 'orderedList',
      getAttrs: (tok, tokens, i) => ({
        start: +tok.attrGet('start') || 1,
        tight: listIsTight(tokens, i),
      }),
    },
    heading: { block: 'heading', getAttrs: tok => ({ level: +tok.tag.slice(1) }) },
    code_block: { block: 'codeBlock', noCloseToken: true },
    fence: { block: 'codeBlock', getAttrs: tok => ({ language: tok.info || null }), noCloseToken: true },
    hr: { node: 'horizontalRule' },
    hardbreak: { node: 'hardBreak' },
    image: { ignore: true },
    link: { ignore: true },
    em: { mark: 'italic' },
    strong: { mark: 'bold' },
    s: { mark: 'strike' },
    code_inline: { mark: 'code', noCloseToken: true },
  })
}
