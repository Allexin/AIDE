/**
 * JSON Schema of a machine file (`aide/pipelines/*.json`), returned by the
 * `pipeline_schema` MCP tool for agents that author machines. Cross-step rules
 * (unique ids, references, loop targets, sessions) are checked by `pipeline_validate`.
 */

const CONDITION = { type: 'string', description: '"<ref> == <literal>" or "<ref> != <literal>", e.g. "outputs.review.verdict != \'accept\'". Refs: params.x, outputs.<step>.<field>, run.iteration.' }
const STEPS = { type: 'array', items: { $ref: '#/$defs/step' } }
const ID = { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_-]*$', description: 'Unique across the machine; used in outputs.<id>.' }

const AGENT = {
  type: 'object',
  required: ['type', 'id', 'summary', 'role', 'output'],
  properties: {
    type: { const: 'agent' },
    id: ID,
    summary: { type: 'string', description: 'One line telling the other agents what this step does.' },
    role: { type: 'string', description: 'Role file relative to the machine file, e.g. "roles/implementer.md".' },
    cli: { type: 'string', description: 'CLI tool id; defaults to defaults.cli.' },
    model: { type: 'string' },
    permissions: { enum: ['read-only', 'write'], description: 'Default write. Reviewers: read-only.' },
    session: { type: 'string', description: '"keep" (default: each visit continues this step\'s own session), "new" (fresh every visit), or "continue:<earlier agent step>".' },
    task: { type: 'string', description: 'Task text; may use {{params.x}} and {{outputs.step.field}}.' },
    inputs: { type: 'array', items: { type: 'string' }, description: 'References rendered into the prompt: params.x, outputs.<step>.<field>, run.diff, run.stagedDiff, run.changedFiles.' },
    output: { type: 'string', description: 'Output schema: a name from "schemas" or a built-in (implementerReport, reviewVerdict, commitPrep, commitReview).' },
    timeoutMin: { type: 'number' },
    repeatIf: { ...CONDITION, description: `Inside a loop: when true, the loop starts its next iteration with this step's output as feedback. ${CONDITION.description}` },
    repeatLoop: { type: 'string', description: 'Id of the enclosing loop that repeatIf repeats; default the innermost.' },
    escalateIf: { ...CONDITION, description: `When true, the run waits for a decision from escalateTo. ${CONDITION.description}` },
    escalateMessage: { type: 'string' },
    escalateTo: { enum: ['user', 'orchestrator'], description: 'Default orchestrator.' }
  }
}

export const MACHINE_FILE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'AIDE pipeline machine',
  description: 'A tree of steps executed top to bottom. No jumps: control moves to the next step, into a block, or back to the start of an enclosing loop.',
  type: 'object',
  required: ['id', 'name', 'description', 'steps'],
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
        cli: { type: 'string', description: 'CLI tool id for agent steps without their own, e.g. "claude-code" or "codex".' },
        model: { type: 'string' },
        timeoutMin: { type: 'number' }
      }
    },
    schemas: { type: 'object', description: 'Named JSON Schemas for agent outputs. Codex steps need strict schemas (additionalProperties false, all properties required).' },
    steps: STEPS
  },
  $defs: {
    step: {
      oneOf: [
        { $ref: '#/$defs/agent' },
        {
          type: 'object',
          required: ['type', 'id', 'command'],
          properties: {
            type: { const: 'check' }, id: ID, summary: { type: 'string' },
            command: { type: 'string', description: 'Shell command run in the project root; success = exit code 0. Inside a loop a failure repeats the loop with the output as feedback; outside any loop it stops the run for a decision.' },
            timeoutMin: { type: 'number' },
            repeatLoop: { type: 'string', description: 'Enclosing loop a failure repeats; default the innermost.' }
          }
        },
        {
          type: 'object',
          required: ['type', 'id', 'question'],
          properties: {
            type: { const: 'gate' }, id: ID, summary: { type: 'string' },
            question: { type: 'string' },
            to: { enum: ['user', 'orchestrator'], description: 'Default orchestrator.' },
            repeatLoop: { type: 'string', description: 'Enclosing loop a rejection repeats; default the innermost. Outside any loop a rejection fails the run.' }
          }
        },
        {
          type: 'object',
          required: ['type', 'id', 'loop'],
          properties: {
            type: { const: 'repeat' }, id: ID, summary: { type: 'string' },
            loop: { type: 'string', description: 'Id of an enclosing loop to start over (like "continue"). Usually inside an "if".' },
            reason: { type: 'string', description: 'Shown to the agents of the next iteration, with the output of the step that ran before.' }
          }
        },
        {
          type: 'object',
          required: ['type', 'id', 'prep', 'review'],
          properties: {
            type: { const: 'commit' }, id: ID, summary: { type: 'string' },
            prep: { $ref: '#/$defs/agent', description: 'Agent that stages the change and outputs commitMessage + excluded (schema "commitPrep"). Usually session "continue:<implementer>".' },
            review: { enum: ['algorithmic', 'agent'] },
            reviewer: { type: 'object', required: ['role'], properties: { role: { type: 'string' }, cli: { type: 'string' }, model: { type: 'string' }, timeoutMin: { type: 'number' } } },
            maxAttempts: { type: 'integer', minimum: 1, description: 'Prep → review attempts; default 3.' },
            onLimit: { enum: ['escalate', 'fail'], description: 'Default escalate.' }
          }
        },
        {
          type: 'object',
          required: ['type', 'id', 'maxIterations', 'steps'],
          properties: {
            type: { const: 'loop' }, id: ID, name: { type: 'string' }, summary: { type: 'string' },
            maxIterations: { type: 'integer', minimum: 1 },
            onLimit: { enum: ['escalate', 'fail'], description: 'Default escalate.' },
            steps: STEPS
          }
        },
        {
          type: 'object',
          required: ['type', 'id', 'steps'],
          properties: { type: { const: 'group' }, id: ID, name: { type: 'string' }, summary: { type: 'string' }, steps: STEPS }
        },
        {
          type: 'object',
          required: ['type', 'id', 'condition', 'then'],
          properties: { type: { const: 'if' }, id: ID, summary: { type: 'string' }, condition: CONDITION, then: STEPS, else: STEPS }
        }
      ]
    },
    agent: AGENT
  }
}
