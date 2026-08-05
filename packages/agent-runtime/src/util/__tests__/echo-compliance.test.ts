/**
 * ECHO compliance tracker tests — FID-2026-0804-009.
 *
 * Covers the pure evaluators (verification detection, security paths, new-API
 * heuristic, user-requested-review, Verifier criteria) and the tracker's
 * behavior: Law 1 read-before-write (read-then-write passes, write-without-read
 * flags, new files exempt, content-knowledge exempt), Law 3 verify-after-write,
 * the mechanical Verifier-criteria flag (10+ lines, 2+ files, security,
 * Forge-without-Verifier), FID escalation, and steering budgeting.
 */

import { describe, expect, it } from 'bun:test'

import {
  EchoComplianceTracker,
  detectsVerificationCommand,
  hasNewApiDeclaration,
  isSecuritySensitivePath,
  meetsVerifierCriteria,
  userRequestedReview,
} from '../echo-compliance'

describe('detectsVerificationCommand', () => {
  it('detects typecheck / test / lint / build-verify commands', () => {
    expect(detectsVerificationCommand('bun run --cwd=common typecheck')).toBe(
      true,
    )
    expect(detectsVerificationCommand('bun test src/')).toBe(true)
    expect(detectsVerificationCommand('bun x eslint . --max-warnings 0')).toBe(
      true,
    )
    expect(detectsVerificationCommand('cargo check')).toBe(true)
    expect(detectsVerificationCommand('go test ./...')).toBe(true)
    expect(detectsVerificationCommand('npm run lint:md')).toBe(true)
  })

  it('does not flag non-verification commands', () => {
    expect(detectsVerificationCommand('git status')).toBe(false)
    expect(detectsVerificationCommand('ls -la')).toBe(false)
    expect(detectsVerificationCommand('cat README.md')).toBe(false)
    expect(detectsVerificationCommand('bun install')).toBe(false)
  })
})

describe('isSecuritySensitivePath', () => {
  it('flags auth/payment/credential/token paths', () => {
    expect(isSecuritySensitivePath('src/auth/login.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/payment/checkout.ts')).toBe(true)
    expect(isSecuritySensitivePath('src/credentials.ts')).toBe(true)
    expect(isSecuritySensitivePath('.env')).toBe(true)
    expect(isSecuritySensitivePath('src/webhook/stripe.ts')).toBe(true)
  })

  it('does not flag ordinary paths', () => {
    expect(isSecuritySensitivePath('src/components/button.tsx')).toBe(false)
    expect(isSecuritySensitivePath('src/utils/format.ts')).toBe(false)
    expect(isSecuritySensitivePath('README.md')).toBe(false)
  })
})

describe('hasNewApiDeclaration', () => {
  it('flags export function / export const / class declarations', () => {
    expect(hasNewApiDeclaration('export function createUser() {}')).toBe(true)
    expect(hasNewApiDeclaration('export const handler = () => {}')).toBe(true)
    expect(hasNewApiDeclaration('class UserService {}')).toBe(true)
    expect(hasNewApiDeclaration('export interface User {}')).toBe(true)
  })

  it('does not flag ordinary code', () => {
    expect(hasNewApiDeclaration('const x = 1')).toBe(false)
    expect(hasNewApiDeclaration('console.log("hi")')).toBe(false)
  })
})

describe('userRequestedReview', () => {
  it('detects review/audit/verify requests in the prompt', () => {
    expect(userRequestedReview('please review my changes')).toBe(true)
    expect(userRequestedReview('audit the auth flow')).toBe(true)
    expect(userRequestedReview('add a login page')).toBe(false)
  })
})

describe('meetsVerifierCriteria', () => {
  it('triggers on 10+ lines, 2+ files, new API, security, Forge, or review request', () => {
    const base = {
      linesAdded: 0,
      filesTouched: 1,
      newApiHint: false,
      securitySensitive: false,
      forgeUsed: false,
      userRequestedReview: false,
    }
    expect(meetsVerifierCriteria({ ...base, linesAdded: 10 })).toBe(true)
    expect(meetsVerifierCriteria({ ...base, linesAdded: 9 })).toBe(false)
    expect(meetsVerifierCriteria({ ...base, filesTouched: 2 })).toBe(true)
    expect(meetsVerifierCriteria({ ...base, newApiHint: true })).toBe(true)
    expect(meetsVerifierCriteria({ ...base, securitySensitive: true })).toBe(
      true,
    )
    expect(meetsVerifierCriteria({ ...base, forgeUsed: true })).toBe(true)
    expect(meetsVerifierCriteria({ ...base, userRequestedReview: true })).toBe(
      true,
    )
    expect(meetsVerifierCriteria(base)).toBe(false)
  })
})

describe('EchoComplianceTracker — Law 1 (read-before-write)', () => {
  it('passes a write after the file was read', () => {
    const t = new EchoComplianceTracker()
    t.recordRead(['/proj/src/a.ts'])
    const v = t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 5,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    expect(v).toBeNull()
  })

  it('flags a write without a prior read', () => {
    const t = new EchoComplianceTracker()
    const v = t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 5,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    expect(v).not.toBeNull()
    expect(v?.law).toBe('law1')
    expect(v?.severity).toBe('warning')
  })

  it('exempts brand-new files (cannot read what does not exist)', () => {
    const t = new EchoComplianceTracker()
    const v = t.recordWrite({
      path: '/proj/src/new.ts',
      lineDelta: 20,
      contentKnowledge: false,
      isNewFile: true,
      securitySensitive: false,
    })
    expect(v).toBeNull()
  })

  it('exempts content-knowledge writes (str_replace with exact oldString)', () => {
    const t = new EchoComplianceTracker()
    const v = t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 2,
      contentKnowledge: true,
      isNewFile: false,
      securitySensitive: false,
    })
    expect(v).toBeNull()
  })

  it('treats a directory read as covering writes beneath it', () => {
    const t = new EchoComplianceTracker()
    t.recordDirectoryRead('/proj/src')
    const v = t.recordWrite({
      path: '/proj/src/deep/nested/a.ts',
      lineDelta: 3,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    expect(v).toBeNull()
  })

  it('downgrades to info when the user prompt mentions the file', () => {
    const t = new EchoComplianceTracker({ userPrompt: 'update a.ts please' })
    const v = t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 3,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    expect(v?.severity).toBe('info')
  })

  it('is a no-op in off mode', () => {
    const t = new EchoComplianceTracker({ mode: 'off' })
    const v = t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 3,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    expect(v).toBeNull()
  })
})

describe('EchoComplianceTracker — Law 3 (verify-after-write)', () => {
  it('flags writes without a subsequent verification command at turn end', () => {
    const t = new EchoComplianceTracker()
    t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 12,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    const violations = t.evaluateAtStepBoundary({
      stepNumber: 1,
      endingTurn: true,
    })
    expect(violations.some((v) => v.law === 'law3')).toBe(true)
  })

  it('passes when a verification command ran after the write', () => {
    const t = new EchoComplianceTracker()
    t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 12,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    t.recordVerification('bun run --cwd=common typecheck')
    const violations = t.evaluateAtStepBoundary({
      stepNumber: 1,
      endingTurn: true,
    })
    expect(violations.some((v) => v.law === 'law3')).toBe(false)
  })

  it('does not fire mid-batch (endingTurn false)', () => {
    const t = new EchoComplianceTracker()
    t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 12,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    const violations = t.evaluateAtStepBoundary({
      stepNumber: 1,
      endingTurn: false,
    })
    expect(violations).toEqual([])
  })
})

describe('EchoComplianceTracker — Verifier criteria flag', () => {
  it('flags a 10+ line change without a Verifier or verification', () => {
    const t = new EchoComplianceTracker()
    t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 10,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    const violations = t.evaluateAtStepBoundary({
      stepNumber: 1,
      endingTurn: true,
    })
    expect(violations.some((v) => v.law === 'verifier_criteria')).toBe(true)
  })

  it('flags a Forge-written change when the Verifier was never spawned', () => {
    const t = new EchoComplianceTracker()
    t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 5,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    t.recordSpawn('forge')
    const violations = t.evaluateAtStepBoundary({
      stepNumber: 1,
      endingTurn: true,
    })
    expect(violations.some((v) => v.law === 'verifier_criteria')).toBe(true)
  })

  it('suppresses the flag when the Verifier was spawned', () => {
    const t = new EchoComplianceTracker()
    t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 50,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    t.recordSpawn('verifier')
    const violations = t.evaluateAtStepBoundary({
      stepNumber: 1,
      endingTurn: true,
    })
    expect(violations.some((v) => v.law === 'verifier_criteria')).toBe(false)
  })

  it('suppresses the flag when verification evidence exists', () => {
    const t = new EchoComplianceTracker()
    t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 50,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    t.recordVerification('bun test src/')
    const violations = t.evaluateAtStepBoundary({
      stepNumber: 1,
      endingTurn: true,
    })
    expect(violations.some((v) => v.law === 'verifier_criteria')).toBe(false)
  })

  it('escalates to a fid-law warning when a write touches an active FID', () => {
    const t = new EchoComplianceTracker({
      fidPaths: ['/proj/dev/fids/FID-2026-0804-009-x.md'],
    })
    t.recordWrite({
      path: '/proj/dev/fids/FID-2026-0804-009-x.md',
      lineDelta: 2,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    const violations = t.evaluateAtStepBoundary({
      stepNumber: 1,
      endingTurn: true,
    })
    expect(violations.some((v) => v.law === 'fid')).toBe(true)
    const fid = violations.find((v) => v.law === 'fid')
    expect(fid?.fidId).toBe('FID-2026-0804-009')
  })
})

describe('EchoComplianceTracker — steering', () => {
  it('produces corrective steering for violations, budgeted', () => {
    const t = new EchoComplianceTracker()
    t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 50,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    t.evaluateAtStepBoundary({ stepNumber: 1, endingTurn: true })
    const steering = t.takeSteeringMessages()
    expect(steering.length).toBeGreaterThan(0)
    expect(steering[0]).toContain('[ECHO compliance]')
  })

  it('does not re-emit the same violation twice (dedup)', () => {
    const t = new EchoComplianceTracker()
    t.recordWrite({
      path: '/proj/src/a.ts',
      lineDelta: 50,
      contentKnowledge: false,
      isNewFile: false,
      securitySensitive: false,
    })
    t.evaluateAtStepBoundary({ stepNumber: 1, endingTurn: true })
    const first = t.takeSteeringMessages()
    // Same step re-evaluation returns the same pending set, but takeSteering
    // clears it, so a second drain is empty.
    t.evaluateAtStepBoundary({ stepNumber: 2, endingTurn: true })
    const second = t.takeSteeringMessages()
    expect(first.length).toBeGreaterThan(0)
    expect(second.length).toBe(0)
  })
})
