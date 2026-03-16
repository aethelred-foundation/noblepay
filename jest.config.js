const nextJest = require('next/jest');

const createJestConfig = nextJest({
  dir: './',
});

/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/.next/', '<rootDir>/backend/', '<rootDir>/contracts/'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/pages/_app.tsx',
    '!src/pages/_document.tsx',
    '!src/config/**',
    '!src/types/**',
    '!src/lib/abis.ts',
    '!src/lib/constants.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 89,
      functions: 99,
      lines: 100,
      statements: 98,
    },
  },
};

module.exports = createJestConfig(config);
