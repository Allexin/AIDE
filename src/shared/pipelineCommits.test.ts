import { describe, expect, it } from 'vitest'
import { commitLine, hasSeveralRepos, journalCommitsText, reportHasSeveralRepos, setupSkipReason, skippedCommitReason, skippedLabel } from './pipelineCommits'

describe('pipeline commit labels', () => {
  it('names the repo of a commit only with several repos', () => {
    const commit = { sha: '1a2b3c4d5e6f', message: 'Add X\n\nBody', repo: 'web' }
    expect(commitLine(commit, true)).toBe('web 1a2b3c4d Add X')
    expect(commitLine(commit, false)).toBe('1a2b3c4d Add X')
    expect(journalCommitsText(['1a2b3c4d5e6f', '5e6f7a8b9c'], ['web', 'api'])).toBe('web 1a2b3c4d, api 5e6f7a8b')
    expect(journalCommitsText(['1a2b3c4d5e6f'])).toBe('1a2b3c4d')
  })

  it('tells a setup or a report with several repos', () => {
    expect(hasSeveralRepos({ mode: 'git', repos: [{ id: 'root' }], commits: true })).toBe(false)
    expect(hasSeveralRepos({ mode: 'git', repos: [{ id: 'web' }, { id: 'api' }], commits: true })).toBe(true)
    expect(hasSeveralRepos(undefined)).toBe(false)
    expect(reportHasSeveralRepos({ startCommits: { web: 'a', api: null } })).toBe(true)
    expect(reportHasSeveralRepos({})).toBe(false)
  })

  it('reads why commits are skipped from the setup and from the output of a skipped block', () => {
    expect(setupSkipReason(undefined)).toBeNull()
    expect(setupSkipReason({ mode: 'none' })).toBe('no git')
    expect(setupSkipReason({ mode: 'git', repos: [], commits: false })).toBe('commits disabled')
    expect(setupSkipReason({ mode: 'git', repos: [], commits: true })).toBeNull()
    expect(skippedCommitReason({ skipped: 'commits disabled', checkpoint: null, issues: [] })).toBe('commits disabled')
    expect(skippedCommitReason({ sha: 'x' })).toBeNull()
    expect(skippedCommitReason(null)).toBeNull()
    expect(skippedLabel('commits disabled')).toBe('skipped (commits disabled)')
  })
})
