import { childLists, type AgentStep, type CheckStep, type CommitStep, type GateStep, type MachineDefinition, type RepeatStep, type Step } from '../../../shared/pipelineMachine'

/**
 * The machine's step tree with parent links, for navigation (runner), the
 * pipeline context and validation.
 *
 * Leaves are the steps that execute: agent, check, gate, repeat, and the commit action.
 * A `commit` step is a block whose children are its prep agent and the commit
 * action; the action leaf carries the commit step's own id (blocks and leaves
 * live in separate maps), so `outputs.<commit id>` is the commit result.
 */

export type LeafStep = AgentStep | CheckStep | GateStep | RepeatStep | CommitStep

export interface TreeLeaf {
  kind: 'leaf'
  id: string
  step: LeafStep
  parent: TreeBlock
  /** Which child list of the parent (`if`: 0 = then, 1 = else). */
  list: number
  index: number
  /** Position in document order. */
  order: number
}

export interface TreeBlock {
  kind: 'root' | 'loop' | 'group' | 'if' | 'commit'
  id: string
  step: Step | null
  parent: TreeBlock | null
  list: number
  index: number
  lists: TreeNode[][]
}

export type TreeNode = TreeLeaf | TreeBlock

/** Iteration limit of a loop (`maxIterations`) or commit block (`maxAttempts`, default 3). */
export function blockLimit(block: TreeBlock): number {
  const step = block.step
  if (step?.type === 'loop') return step.maxIterations
  if (step?.type === 'commit') return step.maxAttempts ?? 3
  return 0
}

/** Display name of a block. */
export function blockName(block: TreeBlock): string {
  const step = block.step
  return (step?.type === 'loop' || step?.type === 'group') && step.name ? step.name : block.id
}

/** Callbacks for entering blocks while descending. */
export interface DescendContext {
  /** A loop or commit block is entered from outside (its first iteration starts). */
  enterLoop(block: TreeBlock): void
  /** Evaluate the condition of an `if` block (`run.iteration` is that block's innermost loop). */
  evaluate(condition: string, block: TreeBlock): boolean
}

export class MachineTree {
  readonly root: TreeBlock
  readonly leaves = new Map<string, TreeLeaf>()
  readonly blocks = new Map<string, TreeBlock>()
  /** Leaf ids in document order. */
  readonly order: string[] = []
  /** Ids defined more than once (validation reports them). */
  readonly duplicates: string[] = []

  constructor(machine: MachineDefinition) {
    this.root = { kind: 'root', id: '', step: null, parent: null, list: 0, index: 0, lists: [] }
    this.root.lists = [this.build(Array.isArray(machine?.steps) ? machine.steps : [], this.root, 0)]
  }

  private build(steps: Step[], parent: TreeBlock, list: number): TreeNode[] {
    const nodes: TreeNode[] = []
    for (const step of steps) {
      if (!step || typeof step !== 'object') continue
      const index = nodes.length
      if (step.type === 'agent' || step.type === 'check' || step.type === 'gate' || step.type === 'repeat') {
        nodes.push(this.addLeaf(step, parent, list, index))
        continue
      }
      if (step.type !== 'loop' && step.type !== 'group' && step.type !== 'if' && step.type !== 'commit') continue
      const block: TreeBlock = { kind: step.type, id: step.id, step, parent, list, index, lists: [] }
      if (this.blocks.has(step.id) || this.leaves.has(step.id)) this.duplicates.push(step.id)
      this.blocks.set(step.id, block)
      if (step.type === 'commit') {
        const children: TreeNode[] = []
        if (step.prep && typeof step.prep === 'object') children.push(this.addLeaf(step.prep, block, 0, 0))
        children.push(this.addLeaf(step, block, 0, children.length))
        block.lists = [children]
      } else {
        block.lists = childLists(step).map((childSteps, i) => this.build(childSteps, block, i))
      }
      nodes.push(block)
    }
    return nodes
  }

  private addLeaf(step: LeafStep, parent: TreeBlock, list: number, index: number): TreeLeaf {
    const leaf: TreeLeaf = { kind: 'leaf', id: step.id, step, parent, list, index, order: this.order.length }
    if (this.leaves.has(step.id) || (step.type !== 'commit' && this.blocks.has(step.id))) this.duplicates.push(step.id)
    this.leaves.set(step.id, leaf)
    this.order.push(step.id)
    return leaf
  }

  leaf(id: string | null | undefined): TreeLeaf | undefined {
    return id ? this.leaves.get(id) : undefined
  }

  /** Enclosing blocks of a node, innermost first (without the root). */
  ancestors(node: TreeNode): TreeBlock[] {
    const result: TreeBlock[] = []
    for (let block = node.parent; block && block.kind !== 'root'; block = block.parent) result.push(block)
    return result
  }

  /** Enclosing loops and commit blocks, innermost first — the blocks a step can repeat. */
  repeatable(node: TreeNode): TreeBlock[] {
    return this.ancestors(node).filter((b) => b.kind === 'loop' || b.kind === 'commit')
  }

  /** Loop or commit blocks nested inside `block` (any depth). */
  nestedLoops(block: TreeBlock): TreeBlock[] {
    const result: TreeBlock[] = []
    const visit = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        if (node.kind === 'leaf') continue
        if (node.kind === 'loop' || node.kind === 'commit') result.push(node)
        node.lists.forEach(visit)
      }
    }
    block.lists.forEach(visit)
    return result
  }

  /** Leaf ids inside a block (any depth), in document order. */
  leavesIn(block: TreeBlock): string[] {
    const result: string[] = []
    const visit = (nodes: TreeNode[]): void => {
      for (const node of nodes) node.kind === 'leaf' ? result.push(node.id) : node.lists.forEach(visit)
    }
    block.lists.forEach(visit)
    return result
  }

  /** First leaf of the run, entering blocks on the way. Null for an empty machine. */
  first(ctx: DescendContext): string | null {
    return this.descend(this.root.lists[0] ?? [], 0, this.root, ctx)
  }

  /** The leaf to run after `node` completed normally (a loop whose last step completes has passed). */
  next(node: TreeNode, ctx: DescendContext): string | null {
    const parent = node.parent
    if (!parent) return null
    const siblings = parent.lists[node.list] ?? []
    if (node.index + 1 < siblings.length) return this.descend(siblings, node.index + 1, parent, ctx)
    return this.next(parent, ctx)
  }

  /** Restart a loop/commit block from its first step (the caller updates iterations). */
  restart(block: TreeBlock, ctx: DescendContext): string | null {
    return this.descend(block.lists[0] ?? [], 0, block, ctx)
  }

  private descend(nodes: TreeNode[], from: number, owner: TreeBlock, ctx: DescendContext): string | null {
    for (let i = from; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.kind === 'leaf') return node.id
      if (node.kind === 'loop' || node.kind === 'commit') ctx.enterLoop(node)
      if (node.kind === 'if') {
        const step = node.step as Extract<Step, { type: 'if' }>
        return this.descend(node.lists[ctx.evaluate(step.condition, node) ? 0 : 1] ?? [], 0, node, ctx)
      }
      return this.descend(node.lists[0] ?? [], 0, node, ctx)
    }
    return owner.kind === 'root' ? null : this.next(owner, ctx)
  }
}
