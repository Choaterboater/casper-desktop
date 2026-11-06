// @vitest-environment jsdom

/**
 * Casper Sessions record Casper's tool steps as the Standard tools' calls and
 * results (`casper-agent`'s `views.ts`). The shapes it records are kept in its
 * golden file; these tests hold Standard's card models to accepting each one,
 * so a change on either side shows up here.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { bindSnapshotSelector, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { diffCardModel } from '../src/client/tool/models/diff-card-model.ts'
import { readCardModel } from '../src/client/tool/models/read-card-model.ts'
import { searchCardModel } from '../src/client/tool/models/search-card-model.ts'
import { terminalCardModel } from '../src/client/tool/models/terminal-card-model.ts'
import { webCardModel } from '../src/client/tool/models/web-card-model.ts'
import { FileMutationRow } from '../src/client/tool/toolviews/file-mutation-row.tsx'

afterEach(cleanup)

/** One recorded Casper step: the Standard tool name, its arguments, and its result. */
interface Shape {
  readonly case: string
  readonly name: string
  readonly args: Record<string, unknown>
  readonly result: { readonly content: { type: 'text'; text: string }[]; readonly isError: boolean; readonly meta?: ToolResultNode['meta'] }
}

const GOLDEN = resolve(import.meta.dirname, '../../../casper/casper-agent/tests/fixtures/standard-shapes.json')
const SHAPES = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Shape[]
const CWD = '/work/project'
const SID = 's1' as SessionId
const t = makeTranslate(zh, commonZh)

function shape(name: string): Shape {
  const found = SHAPES.find(entry => entry.case === name)
  if (found === undefined) throw new Error(`no golden shape "${name}"`)
  return found
}

function running(entry: Shape): StartedToolCall {
  const argsRaw = JSON.stringify(entry.args)
  return { phase: 'start', args: PartialArguments.fromText(argsRaw), callId: 'c1', name: entry.name, argsRaw, turn: 1, step: 1, time: 1_000, subCalls: [] }
}

function settled(entry: Shape): ToolResultNode {
  const argsRaw = JSON.stringify(entry.args)
  return {
    kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1', name: entry.name, args: PartialArguments.fromText(argsRaw),
    call: { name: entry.name, argsRaw }, callTime: 1_000,
    content: entry.result.content, isError: entry.result.isError, meta: entry.result.meta, subCalls: [],
  }
}

describe('Standard card models on the shapes a Casper Session records', () => {
  it('cover every row of the golden file', () => {
    expect(SHAPES.map(entry => entry.case)).toEqual([
      'edit', 'write a new file', 'write over a file', 'bash', 'bash exit 3', 'powershell', 'read', 'grep', 'find', 'ls', 'web_search', 'web_fetch',
    ])
  })

  it('draw the edit and write diffs while running and once settled', () => {
    for (const name of ['edit', 'write a new file', 'write over a file']) {
      const entry = shape(name)
      expect(diffCardModel(running(entry))?.card.diffs.length, name).toBeGreaterThan(0)
      expect(diffCardModel(settled(entry))?.card.diffs.length, name).toBeGreaterThan(0)
    }
    // The applied hunk keeps the label the model gave the file.
    expect(diffCardModel(settled(shape('edit')))?.card.diffs[0]?.path).toBe('src/sum.js')
  })

  it('draw a terminal card with the exit status for bash and pwsh', () => {
    expect(terminalCardModel(settled(shape('bash')), CWD)?.card).toMatchObject({ output: 'ok 1 sum', exitCode: 0, running: false })
    expect(terminalCardModel(settled(shape('bash exit 3')), CWD)?.card).toMatchObject({ output: '5', exitCode: 3, running: false })
    expect(terminalCardModel(settled(shape('powershell')), CWD)?.card).toMatchObject({ output: 'sum.js', exitCode: 0 })
    expect(terminalCardModel(running(shape('bash')), CWD)?.card.running).toBe(true)
  })

  it('draw the read preview lines', () => {
    expect(readCardModel(settled(shape('read')), CWD)).toEqual({
      label: 'src/sum.js',
      lines: [{ number: 1, text: 'function sum(a, b) {' }, { number: 2, text: '  return a + b' }, { number: 3, text: '}' }],
      totalLines: 3,
      lang: 'js',
    })
  })

  it('draw grep matches grouped by file and glob path lists', () => {
    expect(searchCardModel(settled(shape('grep')))?.card).toMatchObject({ kind: 'matches', total: 1, files: [{ path: 'src/sum.js' }] })
    expect(searchCardModel(settled(shape('find')))?.card).toMatchObject({ kind: 'paths', paths: ['src/sum.js'] })
    expect(searchCardModel(settled(shape('ls')))?.card).toMatchObject({ kind: 'paths', paths: ['notes.txt', 'src/'] })
  })

  it('draw web search sources and the fetched page', () => {
    expect(webCardModel(settled(shape('web_search')))).toMatchObject({ kind: 'search', sources: [{ url: 'https://nodejs.org/api/assert.html' }] })
    expect(webCardModel(settled(shape('web_fetch')))).toMatchObject({ kind: 'fetch', url: 'https://example.com/', statusCode: 200 })
  })

  it('render the edit diff in the file mutation row', () => {
    const list = createSnapshotStore<SessionListState>({
      ids: [SID],
      byId: { [SID]: { id: SID, displayTitle: 'r', running: false, retainedBy: {}, blank: false, updatedAt: 0, cwd: CWD } },
      phase: 'ready',
      projectionsBySession: {},
    })
    const block = settled(shape('edit'))
    const view = render(<FileMutationRow {...{
      useDisclosure, callId: 'c1', toolName: 'edit', phase: 'result' as const, block, openFile: vi.fn(), cwd: CWD,
      useContextMenu: contextMenuHook(), resolveFilePath: (path: string) => path,
      sessionId: SID, useSessions: bindSnapshotSelector(list), t,
    } as Parameters<typeof FileMutationRow>[0]} />)
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(view.container.querySelector('[data-diff]')).not.toBeNull()
    expect(view.container.textContent).toContain('return a + b')
    expect(view.container.textContent).toContain('src/sum.js')
  })
})
