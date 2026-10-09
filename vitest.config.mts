import { defineConfig } from 'vitest/config'

// Unit tests for pure main-process logic (pipeline engine, CLI adapters,
// parsers) and renderer helpers that do not touch the DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000
  }
})
