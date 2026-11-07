/**
 * One current-Casper tool call per row of the Standard view table, as Casper
 * sends it over ACP. `views.spec.ts` checks that each maps to the shape in
 * `fixtures/standard-shapes.json`, and the ui-tool package checks that
 * Standard's card models accept every shape there.
 */

import type { ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk'

/** The Session folder the cases run in. */
export const CASE_CWD = '/work/project'

/** One tool call: its start and its final update. */
export interface StandardCase {
  /** Name of the row in the golden file. */
  readonly case: string
  readonly call: ToolCall
  readonly end: ToolCallUpdate
}

const text = (value: string) => ({ type: 'content' as const, content: { type: 'text' as const, text: value } })

const SUM_OLD = 'function sum(a, b) {\n  return a - b\n}\n'
const SUM_NEW = 'function sum(a, b) {\n  return a + b\n}\n'

/** The table's rows, in order. */
export const STANDARD_CASES: readonly StandardCase[] = [
  {
    case: 'edit',
    call: {
      toolCallId: 'casper-tool-1', title: 'edit src/sum.js', kind: 'edit', status: 'in_progress',
      rawInput: { path: 'src/sum.js', edits: [{ oldText: '  return a - b', newText: '  return a + b' }] },
      locations: [{ path: `${CASE_CWD}/src/sum.js` }],
      content: [{ type: 'diff', path: `${CASE_CWD}/src/sum.js`, oldText: '  return a - b', newText: '  return a + b' }],
      _meta: { casper: { tool: 'edit', target: 'src/sum.js' } },
    },
    end: {
      toolCallId: 'casper-tool-1', status: 'completed',
      content: [{ type: 'diff', path: `${CASE_CWD}/src/sum.js`, oldText: SUM_OLD.trimEnd(), newText: SUM_NEW.trimEnd() }],
      locations: [{ path: `${CASE_CWD}/src/sum.js`, line: 1 }],
      rawOutput: { path: 'src/sum.js', added: 1, removed: 1 },
    },
  },
  {
    case: 'write a new file',
    call: {
      toolCallId: 'casper-tool-2', title: 'write notes.txt', kind: 'edit', status: 'in_progress',
      rawInput: { path: 'notes.txt', content: 'the code word is PLUM\n' },
      locations: [{ path: `${CASE_CWD}/notes.txt` }],
      _meta: { casper: { tool: 'write', target: 'notes.txt' } },
    },
    end: {
      toolCallId: 'casper-tool-2', status: 'completed',
      content: [{ type: 'diff', path: `${CASE_CWD}/notes.txt`, oldText: null, newText: 'the code word is PLUM\n' }],
      rawOutput: { path: 'notes.txt', added: 1, removed: 0, created: true },
    },
  },
  {
    case: 'write over a file',
    call: {
      toolCallId: 'casper-tool-3', title: 'write src/sum.js', kind: 'edit', status: 'in_progress',
      rawInput: { path: 'src/sum.js', content: SUM_NEW },
      locations: [{ path: `${CASE_CWD}/src/sum.js` }],
      _meta: { casper: { tool: 'write', target: 'src/sum.js' } },
    },
    end: {
      toolCallId: 'casper-tool-3', status: 'completed',
      content: [{ type: 'diff', path: `${CASE_CWD}/src/sum.js`, oldText: SUM_OLD, newText: SUM_NEW }],
      rawOutput: { path: 'src/sum.js', added: 1, removed: 1, created: false },
    },
  },
  {
    case: 'bash',
    call: {
      toolCallId: 'casper-tool-4', title: 'bash node test.js', kind: 'execute', status: 'in_progress',
      rawInput: { command: 'node test.js', timeout: 30 },
      _meta: { casper: { tool: 'bash', target: 'node test.js', description: 'Run the sum test' } },
    },
    end: {
      toolCallId: 'casper-tool-4', status: 'completed',
      content: [text('```text\nok 1 sum\n```')],
      rawOutput: { exitCode: 0, truncated: false },
    },
  },
  {
    case: 'bash exit 3',
    call: {
      toolCallId: 'casper-tool-5', title: 'bash node -e', kind: 'execute', status: 'in_progress',
      rawInput: { command: 'node -e "console.log(2 + 3); process.exit(3)"' },
      _meta: { casper: { tool: 'bash', target: 'node -e', description: 'Print the sum and exit 3' } },
    },
    end: {
      toolCallId: 'casper-tool-5', status: 'failed',
      content: [text('```text\n5\n```')],
      rawOutput: { exitCode: 3, truncated: false },
    },
  },
  {
    case: 'powershell',
    call: {
      toolCallId: 'casper-tool-6', title: 'powershell Get-ChildItem', kind: 'execute', status: 'in_progress',
      rawInput: { command: 'Get-ChildItem' },
      _meta: { casper: { tool: 'powershell', target: 'Get-ChildItem' } },
    },
    end: {
      toolCallId: 'casper-tool-6', status: 'completed',
      content: [text('```text\nsum.js\n```')],
      rawOutput: { exitCode: 0, truncated: false },
    },
  },
  {
    case: 'read',
    call: {
      toolCallId: 'casper-tool-7', title: 'read src/sum.js', kind: 'read', status: 'in_progress',
      rawInput: { path: 'src/sum.js', offset: 1, limit: 3 },
      locations: [{ path: `${CASE_CWD}/src/sum.js`, line: 1 }],
      _meta: { casper: { tool: 'read', target: 'src/sum.js' } },
    },
    end: {
      toolCallId: 'casper-tool-7', status: 'completed',
      content: [text(`\`\`\`\n${SUM_NEW}\`\`\``)],
      rawOutput: { path: `${CASE_CWD}/src/sum.js`, offset: 1, lines: 3, totalLines: 3, truncated: false },
    },
  },
  {
    case: 'grep',
    call: {
      toolCallId: 'casper-tool-8', title: 'grep sum', kind: 'search', status: 'in_progress',
      rawInput: { pattern: 'sum', glob: '*.js', ignoreCase: true },
      _meta: { casper: { tool: 'grep', target: 'sum' } },
    },
    end: {
      toolCallId: 'casper-tool-8', status: 'completed',
      content: [text('src/sum.js:1: function sum(a, b) {')],
      rawOutput: { shape: 'matches', files: [{ path: 'src/sum.js', matches: [{ lineNumber: 1, line: 'function sum(a, b) {' }] }], total: 1, truncated: false },
    },
  },
  {
    case: 'find',
    call: {
      toolCallId: 'casper-tool-9', title: 'find *.js', kind: 'search', status: 'in_progress',
      rawInput: { pattern: '*.js', path: 'src' },
      _meta: { casper: { tool: 'find', target: '*.js' } },
    },
    end: {
      toolCallId: 'casper-tool-9', status: 'completed',
      content: [text('src/sum.js')],
      rawOutput: { shape: 'paths', paths: ['src/sum.js'], total: 1, truncated: false },
    },
  },
  {
    case: 'ls',
    call: {
      toolCallId: 'casper-tool-10', title: 'ls .', kind: 'search', status: 'in_progress',
      rawInput: { path: '.' },
      _meta: { casper: { tool: 'ls', target: '.' } },
    },
    end: {
      toolCallId: 'casper-tool-10', status: 'completed',
      content: [text('notes.txt\nsrc/')],
      rawOutput: { shape: 'paths', paths: ['notes.txt', 'src/'], total: 2, truncated: false },
    },
  },
  {
    case: 'web_search',
    call: {
      toolCallId: 'casper-tool-11', title: 'web_search node assert docs', kind: 'search', status: 'in_progress',
      rawInput: { query: 'node assert docs', count: 3 },
      _meta: { casper: { tool: 'web_search', target: 'node assert docs' } },
    },
    end: {
      toolCallId: 'casper-tool-11', status: 'completed',
      content: [text('1. Assert | Node.js documentation\nhttps://nodejs.org/api/assert.html')],
      rawOutput: {
        query: 'node assert docs', provider: 'example',
        sources: [{ url: 'https://nodejs.org/api/assert.html', title: 'Assert | Node.js documentation', snippet: 'The node:assert module provides assertion functions.' }],
        truncated: false,
      },
    },
  },
  {
    case: 'web_fetch',
    call: {
      toolCallId: 'casper-tool-12', title: 'web_fetch https://example.com/', kind: 'fetch', status: 'in_progress',
      rawInput: { url: 'https://example.com/' },
      _meta: { casper: { tool: 'web_fetch', target: 'https://example.com/' } },
    },
    end: {
      toolCallId: 'casper-tool-12', status: 'completed',
      content: [text('Example Domain\nThis domain is for use in documentation examples.')],
      rawOutput: { url: 'https://example.com/', statusCode: 200, title: 'Example Domain', truncated: false },
    },
  },
  {
    // A tool Standard has no card for, failing with a JSON report as its words.
    case: 'casper_check failed',
    call: {
      toolCallId: 'casper-tool-13', title: 'casper_check test', kind: 'execute', status: 'in_progress',
      rawInput: { check: 'test' },
      _meta: { casper: { tool: 'casper_check', target: 'test' } },
    },
    end: {
      toolCallId: 'casper-tool-13', status: 'failed',
      content: [text(JSON.stringify({ name: 'test', command: 'npm run test', cwd: CASE_CWD, status: 'fail', exitCode: 1, coverage: 'not-certified' }))],
    },
  },
  {
    case: 'ask',
    call: {
      toolCallId: 'casper-tool-14', title: 'ask', kind: 'other', status: 'in_progress',
      rawInput: { question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
      _meta: { casper: { tool: 'ask' } },
    },
    end: { toolCallId: 'casper-tool-14', status: 'completed', content: [text('SQLite')] },
  },
]
