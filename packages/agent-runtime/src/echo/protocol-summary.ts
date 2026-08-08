/**
 * FID-2026-0806-005 — condensed ECHO protocol summary, critical-context
 * sentinel, and refresh interval for the session-init gate (Layer 1), the
 * 15-turn refresh (Layer 2), and compaction protection (Layer 3).
 */

/** Marker placed in protocol-bearing messages; compaction must never drop them. */
export const ECHO_CRITICAL_SENTINEL = '<!--echo-critical-->'

/** Layer 2: refresh cadence in main-agent loop iterations. */
export const PROTOCOL_REFRESH_INTERVAL = 15

export function isCriticalContextText(text: string): boolean {
  return text.includes(ECHO_CRITICAL_SENTINEL)
}

/**
 * Condensed protocol summary (~500 tokens) re-injected every 15 turns so the
 * governing laws survive context compaction. The full protocol is always read
 * 0-EOF at session start; this is the refresh, not the source of truth.
 */
export function buildProtocolRefreshSummary(): string {
  return `${ECHO_CRITICAL_SENTINEL}
# ECHO Protocol (condensed refresh — full protocol read at session start)

Governing law set: the ECHO Protocol (Savant harness ECHO.md v0.2.0; single-agent
adaptation v0.1.2). Sign all authored documents as Savant only.

## Laws 1-4 (immutable process)
1. Read 0-EOF before touch — no exceptions, no skimming.
2. Present before act — full impact analysis before implementation; user
   approval before any code is written.
3. Verify before proceed — build/test commands from protocol.config.yaml;
   zero errors, zero warnings.
4. Verify call-graph reachability — grep production entry points after wiring;
   zero grep results = not wired.

## Laws 5-15 (extended, strict mode)
5. No pseudo-code/TODOs/placeholders. 6. No type-safety shortcuts.
7. Search for existing code before creating. 8. Log intent before coding.
9. Production-grade documentation. 10. Update tracking after every feature.
11. Follow discovered patterns exactly. 12. Never expose sensitive data.
13. Utility-first, universal logic. 14. All error paths handled.
15. Build stays clean.

## Perfection Loop FSM
RED (catalog issues + evidence) → GREEN (minimal fix, robust defaults) →
AUDIT (double-audit: static analysis + runtime; tool output only) →
ADVERSARIAL (refute FAILs, re-audit unevidenced PASSes) → COMPLETE
(converged) → IMPLEMENT. Self-correct on audit failure. Code is written only
after the FID converges.

## FID lifecycle
Created → Analyzed → Fixed → Verified → Closed → Archived (auto-archive: move
to dev/fids/archive/, update CHANGELOG). FID metadata is a claim; the code is
ground truth.

## Double audit (single agent)
Method 1: typecheck/lint output. Method 2: re-read changed code against the
FID. Self-reporting is prohibited.

## Session directives
Flag ANY issue, even out of scope. Honest assessment: verification claims need
tool output; design decisions need documented reasoning. Emergency procedures
for stuck tests/compilation/loops. Work one problem at a time; verify every
change; document as you go; commit atomically.`
}
