// Must evaluate before any module that imports common/env (analytics below):
// pins NEXT_PUBLIC_CB_ENVIRONMENT away from prod so the config-dir override
// stays effective even when tests run under the release-gate profile.
import './test-env'
import { beforeEach } from 'bun:test'

import { disableAnalytics } from './utils/analytics'

/**
 * Global test setup for the CLI workspace.
 *
 * The repository's local dev environment often has `DIRECT_PROVIDER` and/or
 * `INFERENCE_BASE_URL` set so the app boots in direct-provider mode. Most unit
 * tests, however, exercise the SavantCode API client against a mocked backend
 * and expect backend-mode behavior. This setup clears those variables before
 * every test so that `isDirectProviderMode()` and the SDK's dev-mode bypass
 * return false by default.
 *
 * Tests that specifically want to verify direct-provider behavior can still
 * set these variables in their own `beforeEach`, which runs after this global
 * setup.
 *
 * Telemetry is disabled for the same reason: `trackEvent` intentionally throws
 * in production when it fires before `initAnalytics` establishes a client, and
 * several startup paths (agent-definition loading, direnv, health/init flows)
 * call it before initialization depending on worker scheduling. Disabling
 * analytics here makes the suite deterministic — no test file can crash on an
 * uninitialized telemetry client — while analytics-focused tests still control
 * their own state via `resetAnalyticsState`/`initAnalytics`.
 */
beforeEach(() => {
  process.env.DIRECT_PROVIDER = ''
  process.env.INFERENCE_BASE_URL = ''
  disableAnalytics()
})
