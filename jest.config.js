/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  transform: {},
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: process.env.CI === 'true'
    ? ['tests/(socratic|incident_agent|shadow_review|mood_state|vector_collections|flashcard_generator|groq_provider|datalog_engine|vibe_coding_audit|privileged_agent|code_sandbox|sandbox_security)\.test\.js']
    : ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'lib/**/*.js',
    'agents/**/*.js',
    '!lib/vector_store_qdrant.js',
    '!lib/bigquery_store.js',
  ],
};
