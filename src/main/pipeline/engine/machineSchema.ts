/**
 * JSON Schema of a machine file (`aide/pipelines/*.json`), returned by the
 * `pipeline_schema` MCP tool for agents that author machines. Graph-level rules
 * (reachability, bounded loops, routes) are checked by `pipeline_validate`.
 */
export const MACHINE_FILE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'AIDE pipeline machine',
  type: 'object',
  required: ['id', 'name', 'description', 'start', 'nodes', 'edges'],
  properties: {
    id: { type: 'string', description: 'Stable identifier, e.g. "code-feature".' },
    name: { type: 'string' },
    description: { type: 'string', description: 'For the orchestrator: when to use this machine, what it needs, what it produces.' },
    params: {
      type: 'object',
      description: 'Inputs the orchestrator must supply at start.',
      additionalProperties: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { enum: ['string', 'string[]', 'path', 'glob[]', 'number', 'boolean'] },
          description: { type: 'string' },
          required: { type: 'boolean', description: 'Default true.' }
        }
      }
    },
    defaults: {
      type: 'object',
      properties: {
        cli: { type: 'string', description: 'CLI tool id for agent nodes without their own, e.g. "claude-code" or "codex".' },
        model: { type: 'string' },
        timeoutMin: { type: 'number' }
      }
    },
    schemas: { type: 'object', description: 'Named JSON Schemas for agent outputs. Built-ins: implementerReport, reviewVerdict, commitPrep, commitReview. Codex nodes need strict schemas (additionalProperties false, all properties required).' },
    start: { type: 'string', description: 'Id of the first node.' },
    nodes: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { enum: ['agent', 'check', 'commit', 'gate', 'escalate', 'end'] },
          summary: { type: 'string', description: 'One line telling earlier agents what this node does. Required for agent nodes.' },
          maxVisits: { type: 'integer', minimum: 1, description: 'Bounds loops. Exceeding it routes to onLimit.' },
          onLimit: { type: 'string', description: 'Node to go to when maxVisits is exceeded (usually an escalate node).' },
          role: { type: 'string', description: 'agent: role file relative to the machine file, e.g. "roles/implementer.md".' },
          cli: { type: 'string' },
          model: { type: 'string' },
          permissions: { enum: ['read-only', 'write'], description: 'agent: default write.' },
          session: { type: 'string', description: 'agent: "new" (default) or "continue:<agent node>" to resume that node\'s CLI session.' },
          task: { type: 'string', description: 'agent: task text; may use {{params.x}} and {{outputs.node.field}}.' },
          inputs: { type: 'array', items: { type: 'string' }, description: 'agent: references included in the prompt: params.x, outputs.node.field, run.diff, run.stagedDiff, run.changedFiles.' },
          output: { type: 'string', description: 'agent: output schema name (required).' },
          timeoutMin: { type: 'number' },
          command: { type: 'string', description: 'check: shell command run in the project root; success = exit code 0.' },
          prep: { type: 'string', description: 'commit: agent node that stages files and outputs commitMessage + excluded.' },
          review: { enum: ['algorithmic', 'agent'], description: 'commit: how the prepared commit is reviewed before committing.' },
          reviewer: { type: 'object', description: 'commit with review "agent": { role, cli?, model? }.' },
          question: { type: 'string', description: 'gate: what to approve.' },
          to: { enum: ['user', 'orchestrator'], description: 'gate / escalate: who answers.' },
          message: { type: 'string', description: 'escalate: what to say.' },
          result: { enum: ['success', 'failure'], description: 'end.' }
        }
      }
    },
    edges: {
      type: 'array',
      description: 'Routes evaluated in order after a node: [from, to, condition]. Condition: "ok", "fail", "default", or "<ref> == <literal>" / "!=", e.g. "outputs.review.verdict == \'accept\'".',
      items: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } }
    }
  }
}
