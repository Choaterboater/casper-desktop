import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk'
import {
  CASPER_MCP,
  HIDDEN_OLD_TEXT,
  STEP_FAILED,
  exitText,
  readEnvelope,
  standardCall,
  standardResult,
  unfence,
  validInclude,
  wireJson,
} from '../src/views.ts'
import { CASE_CWD, STANDARD_CASES } from './standard-cases.ts'
import { parsed } from './support.ts'

const GOLDEN: unknown = JSON.parse(readFileSync(new URL('./fixtures/standard-shapes.json', import.meta.url), 'utf8'))

/** A current Casper's in-progress call of `tool` with the model's arguments. */
type Extra = Partial<ToolCall> & { casper?: Record<string, unknown> }

function call(tool: string, rawInput: Record<string, unknown>, extra: Extra = {}): ToolCall {
  const { casper, ...rest } = extra
  return {
    toolCallId: 'casper-tool-1', title: `${tool} step`, status: 'in_progress', rawInput,
    _meta: { casper: { tool, ...casper } }, ...rest,
  }
}

const done = (extra: Partial<ToolCallUpdate> = {}): ToolCallUpdate => ({ toolCallId: 'casper-tool-1', status: 'completed', ...extra })
const words = (...texts: string[]): NonNullable<ToolCallUpdate['content']> => texts.map(value => ({ type: 'content', content: { type: 'text', text: value } }))

function shape(value: ToolCall, end: ToolCallUpdate) {
  const view = standardCall(value)
  const result = standardResult(view, end)
  return { name: view.name, args: parsed(view.arguments), result }
}

describe('standardCall and standardResult', () => {
  it('map one call per row of the view table to the golden Standard shapes', () => {
    const shapes = STANDARD_CASES.map(({ case: name, call: start, end }) => {
      const { name: tool, args, result } = shape(start, end)
      return {
        case: name, name: tool, args,
        result: { content: [{ type: 'text', text: result.text }], isError: result.isError, ...result.meta === undefined ? {} : { meta: result.meta } },
      }
    })
    expect(shapes).toEqual(GOLDEN)
  })

  it('keeps every edit of a multi-edit call and takes the start\'s locations when the end has none', () => {
    const edits = [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }, { oldText: 1 }, 'x']
    const { args, result } = shape(
      call('edit', { path: 'x.js', edits }, { locations: [{ path: 'relative.js' }, { path: `${CASE_CWD}/x.js` }] }),
      done({ content: [{ type: 'diff', path: `${CASE_CWD}/x.js`, newText: 'b\nd' }] }),
    )
    expect(args).toEqual({ file_path: 'x.js', old_string: 'a', new_string: 'b', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] })
    expect(result).toEqual({
      text: 'Edited x.js', isError: false,
      meta: { path: `${CASE_CWD}/x.js`, diffs: [{ path: `${CASE_CWD}/x.js`, oldText: null, newText: 'b\nd' }] },
    })
  })

  it('reads an edit in each form pi takes, and keeps a hidden edit a change so the produced-files list shows it', () => {
    const args = (input: Record<string, unknown>) => shape(call('edit', { path: '.env', ...input }), done()).args
    const pair = { oldText: 'A=1', newText: 'A=2' }
    const expected = { file_path: '.env', old_string: 'A=1', new_string: 'A=2' }
    expect(args({ edits: pair })).toEqual(expected)
    expect(args({ edits: JSON.stringify([pair]) })).toEqual(expected)
    expect(args({ edits: '[not json' })).toEqual({ file_path: '.env' })
    expect(args(pair)).toEqual(expected)
    // The deliverables list takes an edit only when its old text is not empty and differs from the new text.
    for (const hidden of ['<not shown: adds a secret>', '<not shown: holds a secret>']) {
      expect(args({ edits: [{ oldText: hidden, newText: hidden }] })).toEqual({ file_path: '.env', old_string: HIDDEN_OLD_TEXT, new_string: hidden })
    }
    expect(args({ edits: [{ oldText: 'A=1', newText: '<not shown: adds a secret>' }] }))
      .toEqual({ file_path: '.env', old_string: 'A=1', new_string: '<not shown: adds a secret>' })
    expect(args({ edits: [{ oldText: 'same', newText: 'same' }] })).toEqual({ file_path: '.env', old_string: 'same', new_string: 'same' })
  })

  it('records a secret or too-large edit as Casper\'s note with no diff', () => {
    const note = 'Changed x.env (+1 −0): not shown, it holds a secret'
    expect(shape(call('edit', { path: 'x.env', edits: 'none' }), done({ content: words(note), rawOutput: { path: `${CASE_CWD}/x.env` } })))
      .toEqual({ name: 'edit', args: { file_path: 'x.env' }, result: { text: note, isError: false, meta: { path: `${CASE_CWD}/x.env` } } })
  })

  it('names a file by the call title and omits the path when Casper reports no absolute one', () => {
    expect(shape(call('edit', {}), done({ rawOutput: { path: 'x.js', added: 1 } })).result)
      .toEqual({ text: 'Edited edit step', isError: false, meta: {} })
    expect(shape(call('write', { path: 'n.txt', content: 7 }), done()).result)
      .toEqual({ text: 'Updated n.txt', isError: false, meta: { operation: 'update' } })
  })

  it('records a write Casper marks created without a diff as a create with no hunks', () => {
    expect(shape(call('write', { path: 'n.txt', content: 'x' }), done({ rawOutput: { created: true, path: `${CASE_CWD}/n.txt` } })).result)
      .toEqual({ text: 'Created n.txt', isError: false, meta: { operation: 'create', path: `${CASE_CWD}/n.txt` } })
  })

  it('records bash exit 3 as a completed command with the exit marker, and a failure without an exit code as an error', () => {
    const bash = call('bash', { command: 'false\necho more', timeout: 0 })
    expect(shape(bash, { toolCallId: 'casper-tool-1', status: 'failed', content: words('```\n```'), rawOutput: { exitCode: 3 } }))
      .toEqual({ name: 'bash', args: { command: 'false\necho more', description: 'false' }, result: { text: '\n[exit code: 3]', isError: false } })
    expect(shape(bash, { toolCallId: 'casper-tool-1', status: 'failed', content: words('Not run: the sandbox refused it') }).result)
      .toEqual({ text: 'Not run: the sandbox refused it', isError: true })
    expect(shape(bash, { toolCallId: 'casper-tool-1', status: 'failed', rawOutput: { exitCode: null } }).result)
      .toEqual({ text: STEP_FAILED, isError: true })
  })

  it('marks a completed shell step with an explicitly missing exit code, and passes plain output through', () => {
    const pwsh = call('powershell', {})
    expect(shape(pwsh, done({ content: words('killed'), rawOutput: { exitCode: null } })))
      .toEqual({ name: 'pwsh', args: { description: 'powershell step' }, result: { text: 'killed\n[exit code: null]', isError: false } })
    expect(shape(pwsh, done({ content: words('plain') })).result).toEqual({ text: 'plain', isError: false })
  })

  it('drops an include the Standard search card refuses, and a blank pattern', () => {
    for (const glob of ['', ' ', '!*.js', '*.js,*.ts', 7]) {
      expect(shape(call('grep', { pattern: 'x', glob }), done()).args).toEqual({ pattern: 'x' })
    }
    expect(shape(call('grep', { pattern: 'x', glob: '{a,b}/*.{js,ts}}' }), done()).args).toEqual({ pattern: 'x', include: '{a,b}/*.{js,ts}}' })
    expect(shape(call('grep', { pattern: 4, path: '' }), done()).args).toEqual({})
    expect(shape(call('find', { pattern: '' }), done()).args).toEqual({})
  })

  it('gives no envelope for a cut read Casper did not count, a picture, an unknown-size read, or lines the file cannot hold', () => {
    const read = call('read', { path: 'a.txt', offset: 0, limit: 2.5 })
    const body = words('```\none\ntwo\n```')
    expect(shape(read, done({ content: body, rawOutput: { offset: 1, totalLines: 9, truncated: true } }))).toEqual({
      name: 'read', args: { file_path: 'a.txt' }, result: { text: 'one\ntwo', isError: false },
    })
    expect(shape(read, done({ content: body, rawOutput: { image: true } })).result).toEqual({ text: 'one\ntwo', isError: false })
    expect(shape(read, done({ content: body })).result).toEqual({ text: 'one\ntwo', isError: false })
    expect(shape(read, done({ content: body, rawOutput: { lines: 3 } })).result.meta).toBeUndefined()
    expect(shape(read, done({ content: body, rawOutput: { totalLines: 1 } })).result.meta).toBeUndefined()
    expect(shape(call('read', {}), done({ content: body, rawOutput: {} })).result.meta).toBeUndefined()
  })

  it('builds a read window from Casper\'s counts, dropping its trailing note, and from the reported path', () => {
    const read = call('read', {}, { casper: { target: 'a.md' } })
    const result = standardResult(standardCall(read), done({
      content: words('```\none\ntwo\n[2 more lines in file. Use offset=4 to continue]\n```'),
      rawOutput: { path: `${CASE_CWD}/a.md`, offset: 2, lines: 2, totalLines: 5, truncated: false },
    }))
    expect(result).toEqual({
      text: `<path>${CASE_CWD}/a.md</path>\n<type>file</type>\n<content>\n2: one\n3: two\n\n(Showing lines 2-3 of 5. Use offset=4 to continue.)\n</content>`,
      isError: false,
      meta: { path: `${CASE_CWD}/a.md`, offset: 2, lines: [{ number: 2, text: 'one' }, { number: 3, text: 'two' }], totalLines: 5, lang: 'md' },
    })
    expect(standardResult(standardCall(read), done({ rawOutput: { path: 'a.unknownext', lines: -1, totalLines: 1.5 } })).meta)
      .toEqual({ path: 'a.unknownext', offset: 1, lines: [], totalLines: 0 })
  })

  it('builds a read window Casper marks truncated when it counted the window\'s lines, as for a window that stops early', () => {
    const read = call('read', { path: 'a.txt', limit: 2 })
    const more = standardResult(standardCall(read), done({
      content: words('```\none\ntwo\n[10 more lines in file. Use offset=3 to continue.]\n```'),
      rawOutput: { path: `${CASE_CWD}/a.txt`, offset: 1, lines: 2, totalLines: 12, truncated: true },
    }))
    expect(more.meta).toEqual({ path: `${CASE_CWD}/a.txt`, offset: 1, lines: [{ number: 1, text: 'one' }, { number: 2, text: 'two' }], totalLines: 12 })
    expect(more.text).toContain('(Showing lines 1-2 of 12. Use offset=3 to continue.)')
    // A window whose text was cut shorter than Casper's count gets none.
    const cut = standardResult(standardCall(read), done({
      content: words('```\none\n```'),
      rawOutput: { path: `${CASE_CWD}/a.txt`, offset: 1, lines: 2, totalLines: 40, truncated: true },
    }))
    expect(cut).toEqual({ text: 'one', isError: false })
  })

  it('carries search and web metadata only when Casper sent the shape the card reads', () => {
    const grep = call('grep', { pattern: 'x' })
    expect(shape(grep, done({ rawOutput: { shape: 'paths' } })).result).toEqual({ text: '', isError: false })
    expect(shape(grep, done({ rawOutput: { shape: 'matches', files: [], truncated: false } })).result.meta).toBeUndefined()
    expect(shape(grep, done()).result.meta).toBeUndefined()
    expect(shape(call('ls', {}), done({ rawOutput: { shape: 'matches' } })).result.meta).toBeUndefined()
    expect(shape(call('web_search', { query: '' }), done({ rawOutput: { sources: [], truncated: true, answer: 'yes' } })))
      .toEqual({ name: 'web_search', args: {}, result: { text: '', isError: false, meta: { sources: [], truncated: true, answer: 'yes' } } })
    expect(shape(call('web_fetch', { url: '' }), done({ rawOutput: { url: 'https://example.com/' } })))
      .toEqual({ name: 'web_fetch', args: {}, result: { text: '', isError: false } })
  })

  it('records a failed step with Casper\'s error text, or a plain note when it sent none', () => {
    const failed = { toolCallId: 'casper-tool-1', status: 'failed' } as const
    expect(shape(call('read', { path: 'x' }), { ...failed, content: words('ENOENT: x') }).result).toEqual({ text: 'ENOENT: x', isError: true })
    expect(shape(call('delegate', {}), failed).result).toEqual({ text: STEP_FAILED, isError: true })
  })

  it('names an app tools call after the app tool, and any other MCP call casper_mcp', () => {
    const app = shape(call('mcp', { action: 'list_plugins' }, { casper: { mcp: { server: 'acp-app', tool: 'plugin_manager' } } }), done({ content: words('listed') }))
    expect(app).toEqual({ name: 'plugin_manager', args: { action: 'list_plugins' }, result: { text: 'listed', isError: false } })
    // Reached through call_capability, the app tool's own arguments are the ones it carries.
    const capability = (rawInput: Record<string, unknown>) => call('call_capability', rawInput, { casper: { mcp: { server: 'acp-app', tool: 'cordis_inspect_list' } } })
    expect(shape(capability({ id: 'mcp:acp-app:cordis_inspect_list', arguments: { platform: 'client' } }), done()).args).toEqual({ platform: 'client' })
    expect(shape(capability({ id: 'mcp:acp-app:cordis_inspect_list' }), done()).args).toEqual({})
    const other = { content: [{ type: 'content' as const, content: { type: 'text' as const, text: 'preview' } }] }
    expect(shape(call('mcp', { q: 1 }, { ...other, casper: { mcp: { server: 'acp-docs', tool: 'search' } } }), done({ rawOutput: { hits: 2 } }))).toEqual({
      name: CASPER_MCP, args: { title: 'mcp step', q: 1, preview: 'preview' }, result: { text: '{"hits":2}', isError: false },
    })
    expect(standardCall(call('mcp', {}, { casper: { mcp: { server: 'acp-app', tool: 'unknown' } } })).name).toBe(CASPER_MCP)
    expect(standardCall(call('mcp', {}, { casper: { mcp: { server: 'acp-app' } } })).name).toBe(CASPER_MCP)
  })

  it('keeps any other Casper tool as casper_<tool> with its title and arguments', () => {
    expect(shape(call('Delegate-Agent', { goal: 'g' }), done({ rawOutput: null }))).toEqual({
      name: 'casper_delegate_agent', args: { title: 'Delegate-Agent step', goal: 'g' }, result: { text: '', isError: false },
    })
  })

  it('keeps a Casper tool already named casper_<tool> without doubling the prefix', () => {
    expect(shape(call('casper_check', { check: 'test' }), done({ content: words('passed') }))).toEqual({
      name: 'casper_check', args: { title: 'casper_check step', check: 'test' }, result: { text: 'passed', isError: false },
    })
    expect(standardCall(call('Casper-Check', {})).name).toBe('casper_check')
  })

  it('falls back for an older Casper: the tool from rawInput.tool with its target, then the kind', () => {
    const legacy = (rawInput: unknown, kind?: ToolCall['kind']): ToolCall => ({
      toolCallId: 'casper-tool-1', title: 'step', status: 'in_progress', rawInput, ...kind === undefined ? {} : { kind },
    })
    expect(standardCall(legacy({ tool: 'bash', target: 'npm test' }))).toMatchObject({
      kind: 'standard', name: 'bash', arguments: JSON.stringify({ command: 'npm test', description: 'npm test' }),
    })
    expect(standardCall(legacy({ tool: 'read' }))).toMatchObject({ name: 'read', arguments: '{}' })
    expect(standardCall(legacy({ tool: 'grep', target: 'sum' }))).toMatchObject({ name: 'grep', arguments: '{"pattern":"sum"}' })
    expect(standardCall(legacy({ tool: 'plugin_manager', target: 'install' }))).toMatchObject({
      kind: 'casper', name: 'casper_plugin_manager', arguments: JSON.stringify({ title: 'step', tool: 'plugin_manager', target: 'install' }),
    })
    expect(standardCall(legacy(undefined, 'edit'))).toMatchObject({ name: 'edit', arguments: '{}' })
    expect(standardCall(legacy([], 'execute'))).toMatchObject({ name: 'casper_execute' })
    expect(standardCall(legacy(null))).toMatchObject({ name: 'casper_tool' })
    // A result for the older shape shows Casper's words, never the bare status.
    expect(standardResult(standardCall(legacy({ tool: 'bash', target: 'ls' })), done())).toEqual({ text: '', isError: false })
  })
})

describe('unfence', () => {
  it('strips one whole fence and leaves anything else', () => {
    expect(unfence('```text\na\n```')).toBe('a')
    expect(unfence('````\n```inner```\n````\n')).toBe('```inner```')
    expect(unfence('~~~\n\n~~~')).toBe('')
    expect(unfence('```\n```')).toBe('')
    expect(unfence('```\na\n````')).toBe('```\na\n````')
    expect(unfence('plain')).toBe('plain')
  })
})

describe('exitText', () => {
  it('adds the Standard marker for every code but 0', () => {
    expect(exitText('out', 0)).toBe('out')
    expect(exitText('out', 2)).toBe('out\n[exit code: 2]')
    expect(exitText('out', null)).toBe('out\n[exit code: null]')
  })
})

describe('readEnvelope', () => {
  it('builds an empty window and refuses a window past the file', () => {
    expect(readEnvelope({ displayPath: 'e.txt', path: 'e.txt', offset: 1, body: '', lines: undefined, totalLines: 0 })).toEqual({
      text: '<path>e.txt</path>\n<type>file</type>\n<content>\n(End of file - total 0 lines)\n</content>',
      meta: { path: 'e.txt', offset: 1, lines: [], totalLines: 0 },
    })
    expect(readEnvelope({ displayPath: 'e.txt', path: 'e.txt', offset: 3, body: 'a\nb', lines: undefined, totalLines: 3 })).toBeUndefined()
  })
})

describe('validInclude', () => {
  it('takes a brace list but no top-level comma list or negation', () => {
    expect(validInclude('*.{js,ts}')).toBe(true)
    expect(validInclude('}a,b')).toBe(false)
    expect(validInclude('!x')).toBe(false)
  })
})

describe('wireJson', () => {
  it('passes JSON and refuses what JSON cannot hold', () => {
    expect(wireJson({ a: [1, 'x', true, null, { b: 2 }] })).toEqual({ a: [1, 'x', true, null, { b: 2 }] })
    expect(wireJson([1, undefined])).toBeUndefined()
    expect(wireJson({ a: undefined })).toBeUndefined()
    expect(wireJson(Number.NaN)).toBeUndefined()
    expect(wireJson(() => 1)).toBeUndefined()
  })
})
