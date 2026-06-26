/** @jest-config-loader esbuild-register */

import type { Config } from 'jest';
import base from './jest.config';

/**
 * Offline unit-test config for the Agentcard integration.
 *
 * The Agentcard OAuth/PKCE/MCP unit tests are pure (no DB/Redis), but the
 * repo's default jest config bootstraps a real Postgres (+pgvector) for every
 * worker via `setupFilesAfterEnv`. This config reuses the base transforms and
 * module aliases but drops that DB bootstrap so the offline tests can run
 * anywhere. Run with: `pnpm exec jest -c jest.agentcard.config.ts`.
 */
const config: Config = {
  ...base,
  globalSetup: undefined,
  setupFiles: ['<rootDir>/src/tests/setup/agentcard-env.ts'],
  setupFilesAfterEnv: [],
  testMatch: ['**/src/lib/agentcard/**/*.test.ts'],
};

export default config;
