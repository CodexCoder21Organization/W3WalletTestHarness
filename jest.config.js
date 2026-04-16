/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  testTimeout: 120_000,
  // Run tests serially: many integration-style tests bind to fixed ports
  // (daemon 7380, demo 18443) and would race if executed in parallel.
  maxWorkers: 1,
};
