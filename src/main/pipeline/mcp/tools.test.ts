import { describe, it, expect } from 'vitest'
import { AIDE_WORK_INSTRUCTION, buildPipelineTools, serverInstructions } from './tools'
import { McpServer } from './protocol'

const helloDescription = (workInstruction?: () => string): string =>
  buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', workInstruction })).find((t) => t.name === 'pipeline_hello')!.description

describe('work instruction', () => {
  it("server instructions carry AIDE's instruction by default and the override when set", () => {
    expect(serverInstructions()).toContain(AIDE_WORK_INSTRUCTION)
    const custom = serverInstructions('Use pipelines only when I ask.')
    expect(custom).toContain('Use pipelines only when I ask.')
    expect(custom).not.toContain(AIDE_WORK_INSTRUCTION)
  })

  it('an empty override leaves no instruction and keeps the rest', () => {
    const text = serverInstructions('  ')
    expect(text).not.toContain(AIDE_WORK_INSTRUCTION)
    expect(text).not.toContain('  ')
    expect(text).toContain('pipeline_hello')
    expect(text).toContain('toolbar_guide')
  })

  it('the pipeline_hello description follows the instruction in effect', () => {
    expect(helloDescription()).toContain(AIDE_WORK_INSTRUCTION)
    expect(helloDescription(() => 'Only when asked.')).toContain('Only when asked.')
    expect(helloDescription(() => '')).not.toContain(AIDE_WORK_INSTRUCTION)
  })

  it('initialize reads instructions given as a function at every call', async () => {
    let current = 'first'
    const server = new McpServer({ name: 'aide', version: 't', instructions: () => current }, () => [])
    const init = async (): Promise<unknown> => {
      const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { projectPath: 'p', connectionId: 'c', tabId: null })
      return (reply as { result: { instructions: string } }).result.instructions
    }
    expect(await init()).toBe('first')
    current = 'second'
    expect(await init()).toBe('second')
  })
})
