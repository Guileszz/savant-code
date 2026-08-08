<!-- markdownlint-disable MD013 -->
# ECHO Protocol

**The governance system that makes Savant Code different.**

ECHO is a multi-agent orchestration protocol that ensures every code change follows a strict process. It's not a suggestion — it's enforced by the harness.

---

## Core Principles

1. **FID-Bound Execution** — Code is never written until the FID (Feature Implementation Document) converges through the Perfection Loop
2. **Separation of Duties** — The agent that writes code cannot verify it
3. **No Deferrals** — Every approved work item must be completed
4. **Evidence-Based Verification** — Claims must be backed by tool output, not self-reporting

---

## The 15 Laws

### Immutable Process Laws (Always Active)

| Law | Name | Description |
|-----|------|-------------|
| **1** | Read 0-EOF Before Touch | Read all relevant files before making any changes |
| **2** | Present Before Act | Show the plan to the user before implementing |
| **3** | Verify Before Proceed | Run verification after implementation |
| **4** | Call-Graph Reachability | Ensure new code is actually called somewhere |

### Extended Code Laws

| Law | Name | Description |
|-----|------|-------------|
| **5** | No Placeholders | No TODO, FIXME, or placeholder code |
| **6** | Type Safety | No `any`, no `@ts-ignore`, no type shortcuts |
| **7** | Error Handling | All error paths must be handled |
| **8** | Search Before Create | Check if similar code/functions already exist |
| **9** | Documentation | Production-grade docs for all public APIs |
| **10** | Test Coverage | New code must have tests |
| **11** | Pattern Compliance | Follow existing codebase conventions |
| **12** | Minimal Changes | Make the smallest change that fixes the issue |
| **13** | Security Awareness | Be mindful of security implications |
| **14** | Graceful Degradation | Fail gracefully, never hard-fail |
| **15** | Attribution | Credit sources and prior work |

---

## The Perfection Loop

Every code change follows a formal Finite State Machine (FSM):

```text
RED → GREEN → AUDIT → ADVERSARIAL → SELF-CORRECT → COMPLETE
  ↑                                            |
  └────────────────────────────────────────────┘
```

### States

1. **RED** — Identify ALL failures and issues with evidence
   - Detective agent runs code search queries
   - Catalogs findings with file paths, line numbers, and grep output
   - Cannot write code — only discovers and reports

2. **GREEN** — Implement minimal, surgical changes
   - Thinker reasons through the fix
   - Recorder documents the FID
   - Forge implements the code
   - Cannot run tests — only writes code

3. **AUDIT** — Independent verification
   - Verifier independently audits the implementation
   - Checks type safety, error handling, call-graph reachability
   - Has zero write tools — completely read-only

4. **ADVERSARIAL** — Meta-verification (FID-2026-0805-004)
   - Adversary refutes every Verifier FAIL (CONFIRMED / REFUTED /
     ADJUSTED with basis), re-audits every unevidenced PASS, resolves
     every `file:line` citation against the code, and re-rates severities
   - Its verdicts override the Verifier's

5. **SELF-CORRECT** — Fix audit findings
   - If issues found, Forge fixes them
   - Verifier re-audits, then Adversary re-audits again
   - Loop until clean

6. **COMPLETE** — Document and archive
   - Recorder archives the FID
   - Updates CHANGELOG
   - Scribe captures session summary

### Circuit Breakers

- **10-iteration hard stop** — If the loop hasn't converged after 10 iterations, it stops
- **Oscillation detection** — If the same issue reappears 3 times, it escalates for review
- **Convergence detection** — Stops when change delta < 2% for 2 consecutive passes
- **Write-phase lock** — Write tools are blocked outside GREEN/SELF-CORRECT phases

---

## FIDs (Feature Implementation Documents)

Every change goes through a FID lifecycle:

```text
created → analyzed → fixed → verified → closed → archived
```

### FID Structure

1. **Problem Statement** — What's broken and why
2. **Evidence** — File paths, line numbers, grep output
3. **Root Cause Analysis** — Why the problem exists
4. **Proposed Solution** — What to change
5. **Verification** — How to verify the fix works
6. **Audit Trail** — Complete history of the change

### FID Rules

- No code is written without a converged FID
- The implementing agent cannot serve as the final verifier
- Every FID must have evidence-based verification
- FIDs are archived after completion for audit trail

---

## Why ECHO Matters

### Without ECHO

- Single model guesses at code
- Self-verification (the model checks its own work)
- No formal process
- Bugs slip through silently

### With ECHO

- 10 specialized agents with restricted tools
- Independent verification by a separate agent
- Formal Perfection Loop with circuit breakers
- Bugs caught structurally, not statistically

---

## Learn More

- [Agent Roster](agents.md) — The 10 agents and their roles
- [Features](features.md) — Key features of Savant Code
- [GitHub](https://github.com/savant0x/savant-code) — Source code
