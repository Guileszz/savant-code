/**
 * `/export` command — serialize the entire conversation into a self-contained,
 * branded HTML report and save it to the current working directory.
 *
 * The exported HTML follows the reference session-export design (monospace,
 * near-black full-width page with corner marks, metadata grid, collapsible
 * tool/thinking rows) and is branded with:
 * - The real Savant logo (art/savant-logo.png) embedded as a base64 data URI
 * - The Neon Slate design system (cli/src/utils/theme-system.ts dark palette)
 * - Font Awesome free icons (6.7.2 CSS + webfonts inlined as base64 — fully offline)
 *
 * Usage:
 *   /export             → writes to ./savant-export-{timestamp}.html
 *   /export output.html → writes to the specified path
 */

import fs from 'fs'
import path from 'path'

import { FONT_AWESOME_ALL_CSS } from '../constants/fontawesome'
import { SAVANT_LOGO_PNG_BASE64 } from '../constants/savant-logo'
import { useChatStore } from '../state/chat-store'
import { IS_SAVANT_FREE } from '../utils/constants'
import { getSystemMessage } from '../utils/message-history'
import { getVersion } from '../utils/version'

import type { RouterParams } from './command-registry'
import type { ChatMessage, ContentBlock } from '../types/chat'

// Logo data URI shared by the header, footer, and Savant row markers.
const LOGO_DATA_URI = `data:image/png;base64,${SAVANT_LOGO_PNG_BASE64}`

// ---------------------------------------------------------------------------
// Helpers (shared with copy-conversation.ts patterns)
// ---------------------------------------------------------------------------

/** Title-case an agent id/type into a display name, e.g. `code-searcher` → `Code Searcher`. */
function formatAgentName(agentName: string): string {
  const cleaned = agentName.replace(/[-_]/g, ' ').trim()
  if (!cleaned) return 'Agent'
  return cleaned.replace(/\b\w/g, (l) => l.toUpperCase())
}

/** Format a timestamp as `MM-DD-YYYY h:mm AM/PM EST` (America/New_York). */
function formatExportTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date)
  const values: Record<string, string> = {}
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value
  }
  return `${values.month}-${values.day}-${values.year} ${values.hour}:${values.minute} ${values.dayPeriod ?? ''} EST`
}

/** Human-friendly tool label, e.g. `read_files` → `Read Files`. */
function toolDisplayName(toolName: string): string {
  if (toolName === 'list_directory') return 'List Directories'
  return toolName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderToolInput(input: unknown): string {
  if (input == null) return ''
  if (
    (Array.isArray(input) && input.length === 0) ||
    (typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.keys(input as Record<string, unknown>).length === 0)
  ) {
    return ''
  }
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

function renderToolOutput(
  output: string,
): { body: string; lang: string } {
  const trimmed = output.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return {
        body: JSON.stringify(JSON.parse(trimmed), null, 2),
        lang: 'json',
      }
    } catch {
      // Not valid JSON — fall through to raw.
    }
  }
  return { body: output, lang: '' }
}

// ---------------------------------------------------------------------------
// HTML block renderers
// ---------------------------------------------------------------------------

function renderTextBlockHtml(text: string, textType?: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (textType === 'reasoning') {
    return `<details class="row-thinking">
  <summary><i class="fa-solid fa-brain thinking-icon" aria-hidden="true"></i><span class="thinking-badge">Thinking</span></summary>
  <div class="thinking-body">${renderMarkdownLikeHtml(trimmed)}</div>
</details>`
  }
  return renderMarkdownLikeHtml(trimmed)
}

/**
 * Minimal markdown-to-HTML for conversation content. Handles:
 * - Code fences (``` ... ```)
 * - Inline code (`...`)
 * - Bold (**...**) and italic (*...*)
 * - Headers (## / ###)
 * - Bullet lists (- ...)
 * - Blockquotes (> ...)
 * - Links [text](url)
 * - Line breaks
 *
 * All inline text is HTML-escaped before formatting so raw `<script>` or other
 * markup in a message can never inject into the exported document.
 */
function renderMarkdownLikeHtml(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  let fenceLang = ''

  for (const line of lines) {
    // Code fence toggle
    const fenceMatch = line.match(/^```(\w*)/)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fenceLang = fenceMatch[1] || ''
        out.push(
          `<pre><code class="${fenceLang ? `language-${fenceLang}` : ''}">`,
        )
      } else {
        inFence = false
        fenceLang = ''
        out.push('</code></pre>')
      }
      continue
    }

    if (inFence) {
      out.push(escapeHtml(line))
      continue
    }

    // Headers
    if (line.startsWith('### ')) {
      out.push(`<h4>${inlineFormat(line.slice(4))}</h4>`)
    } else if (line.startsWith('## ')) {
      out.push(`<h3>${inlineFormat(line.slice(3))}</h3>`)
    } else if (line.startsWith('# ')) {
      out.push(`<h2>${inlineFormat(line.slice(2))}</h2>`)
    }
    // Blockquote
    else if (line.startsWith('> ')) {
      out.push(`<blockquote>${inlineFormat(line.slice(2))}</blockquote>`)
    }
    // Bullet list
    else if (line.match(/^[-*] /)) {
      out.push(`<li>${inlineFormat(line.slice(2))}</li>`)
    }
    // Horizontal rule
    else if (line.match(/^---+$/)) {
      out.push('<hr/>')
    }
    // Empty line
    else if (line.trim() === '') {
      out.push('')
    }
    // Normal text
    else {
      out.push(`<p>${inlineFormat(line)}</p>`)
    }
  }

  return out.join('\n')
}

/** Handle inline markdown: bold, italic, inline code, links. */
function inlineFormat(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
}

function renderToolBlockHtml(
  block: Extract<ContentBlock, { type: 'tool' }>,
): string {
  const name = toolDisplayName(block.toolName)
  const inputText = renderToolInput(block.input)
  const hasInput = inputText.trim().length > 0
  const output = block.output ?? ''
  const hasOutput = output.trim().length > 0

  if (!hasInput && !hasOutput) {
    return `<div class="tool-block"><span class="tool-badge"><i class="fa-solid fa-terminal" aria-hidden="true"></i> ${escapeHtml(name)}</span> <em class="muted">(no input or output)</em></div>`
  }

  const inputSection = hasInput
    ? `<details open>
    <summary><i class="fa-solid fa-arrow-right" aria-hidden="true"></i> Input</summary>
    <pre><code class="language-json">${escapeHtml(inputText)}</code></pre>
  </details>`
    : ''

  const outputSection = hasOutput
    ? (() => {
        const rendered = renderToolOutput(output)
        return `<details>
    <summary><i class="fa-solid fa-arrow-down" aria-hidden="true"></i> Output</summary>
    <pre><code class="${rendered.lang ? `language-${rendered.lang}` : ''}">${escapeHtml(rendered.body)}</code></pre>
  </details>`
      })()
    : ''

  return `<div class="tool-block">
  <div class="tool-header"><span class="tool-badge"><i class="fa-solid fa-terminal" aria-hidden="true"></i> ${escapeHtml(name)}</span></div>
  ${inputSection}
  ${outputSection}
</div>`
}

function renderAgentBlockHtml(
  block: Extract<ContentBlock, { type: 'agent' }>,
): string {
  const label = formatAgentName(block.agentName || block.agentType)
  const header = `Subagent: ${escapeHtml(label)}`
  const promptHtml = block.initialPrompt?.trim()
    ? `<p class="muted"><strong>Prompt:</strong> ${escapeHtml(block.initialPrompt.trim())}</p>`
    : ''
  const contentHtml = block.content?.trim()
    ? renderMarkdownLikeHtml(block.content.trim())
    : ''
  const childrenHtml = (block.blocks ?? [])
    .map((child) => renderBlockHtml(child))
    .join('\n')
  return `<div class="agent-block">
  <div class="agent-header"><i class="fa-solid fa-share-nodes" aria-hidden="true"></i> ${header}</div>
  ${promptHtml}
  ${contentHtml}
  ${childrenHtml}
</div>`
}

function renderPlanBlockHtml(block: Extract<ContentBlock, { type: 'plan' }>): string {
  const content = block.content?.trim()
  if (!content) return ''
  return `<div class="plan-block">
  <div class="plan-header"><i class="fa-solid fa-list-check" aria-hidden="true"></i> Plan</div>
  ${renderMarkdownLikeHtml(content)}
</div>`
}

function renderAskUserBlockHtml(
  block: Extract<ContentBlock, { type: 'ask-user' }>,
): string {
  const questionsHtml = block.questions
    .map((q, i) => {
      const answer = block.answers?.find((a) => a.questionIndex === i)
      const selected =
        answer?.selectedOptions?.join(', ') ??
        answer?.selectedOption ??
        answer?.otherText ??
        (block.skipped ? '(skipped)' : '(no answer)')
      return `<div class="ask-user-question">
    <strong>Q:</strong> ${escapeHtml(q.question)}<br/>
    <em>A:</em> ${escapeHtml(selected)}
  </div>`
    })
    .join('\n')
  return `<div class="ask-user-block">${questionsHtml}</div>`
}

/**
 * Plain-text payload for the per-message copy button. Mirrors the rendered
 * content: text/plan content, tool calls (name + input + output), agent
 * blocks (prompt + content + children), ask-user Q&A, image/attachment notes.
 */
function blockCopyText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.content ?? ''
    case 'tool': {
      const inputText = renderToolInput(block.input)
      // Mirror the rendered output formatting (JSON pretty-printed, raw otherwise).
      const output = renderToolOutput(block.output ?? '').body
      const sections = [toolDisplayName(block.toolName)]
      if (inputText.trim()) sections.push(`Input:\n${inputText}`)
      if (output.trim()) sections.push(`Output:\n${output}`)
      return sections.join('\n\n')
    }
    case 'agent': {
      const parts: string[] = [
        formatAgentName(block.agentName || block.agentType),
      ]
      if (block.initialPrompt?.trim()) {
        parts.push(`Prompt: ${block.initialPrompt.trim()}`)
      }
      if (block.content?.trim()) parts.push(block.content.trim())
      for (const child of block.blocks ?? []) {
        const childText = blockCopyText(child).trim()
        if (childText) parts.push(childText)
      }
      return parts.join('\n\n')
    }
    case 'plan':
      return block.content ?? ''
    case 'ask-user':
      return block.questions
        .map((q, i) => {
          const answer = block.answers?.find((a) => a.questionIndex === i)
          const selected =
            answer?.selectedOptions?.join(', ') ??
            answer?.selectedOption ??
            answer?.otherText ??
            (block.skipped ? '(skipped)' : '(no answer)')
          return `Q: ${q.question}\nA: ${selected}`
        })
        .join('\n\n')
    case 'image':
      return `[Image: ${block.filename ?? block.mediaType ?? 'unknown'}]`
    case 'agent-list':
      return block.agents.map((a) => a.displayName).join(', ')
    default:
      return ''
  }
}

/**
 * Build the plain-text payload for a message's copy button. Mirrors the
 * rendered row exactly (blocks when present, otherwise content — never both),
 * prefixed with who sent it (User / Savant / Error) so a copied section or a
 * full-session paste keeps the speaker attribution.
 */
function buildMessageCopyText(message: ChatMessage, roleLabel: string): string {
  const parts: string[] = []
  if (message.blocks?.length) {
    for (const block of message.blocks) {
      const text = blockCopyText(block).trim()
      if (text) parts.push(text)
    }
  } else if (message.content?.trim()) {
    parts.push(message.content.trim())
  }
  if (message.fileAttachments?.length) {
    parts.push(
      `Attached files: ${message.fileAttachments.map((f) => f.filename).join(', ')}`,
    )
  }
  if (message.attachments?.length) {
    parts.push(
      `Attached images: ${message.attachments.map((a) => a.filename).join(', ')}`,
    )
  }
  if (message.textAttachments?.length) {
    parts.push(
      `Attached ${message.textAttachments.length} pasted text snippet(s)`,
    )
  }
  const body = parts.join('\n\n')
  return body ? `${roleLabel}\n\n${body}` : roleLabel
}

function renderBlockHtml(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return renderTextBlockHtml(block.content ?? '', block.textType)
    case 'tool':
      return renderToolBlockHtml(block)
    case 'agent':
      return renderAgentBlockHtml(block)
    case 'plan':
      return renderPlanBlockHtml(block)
    case 'ask-user':
      return renderAskUserBlockHtml(block)
    case 'image':
      return `<p class="muted"><i class="fa-solid fa-image" aria-hidden="true"></i> [Image: ${escapeHtml(block.filename ?? block.mediaType ?? 'unknown')}]</p>`
    case 'agent-list': {
      const names = block.agents.map((a) => a.displayName).join(', ')
      return names
        ? `<p class="muted"><i class="fa-solid fa-users" aria-hidden="true"></i> [Available agents: ${escapeHtml(names)}]</p>`
        : ''
    }
    default:
      return ''
  }
}

function renderMessageHtml(message: ChatMessage, index: number): string {
  const roleClass =
    message.variant === 'user'
      ? 'row-user'
      : message.variant === 'error'
        ? 'row-error'
        : 'row-assistant'

  const roleLabel =
    message.variant === 'user'
      ? 'User'
      : message.variant === 'error'
        ? 'Error'
        : 'Savant'

  // Copy-button payload: the plain text of this message (with sender label),
  // JSON-encoded so it round-trips through the HTML attribute (quotes/entities
  // decode correctly).
  const copyPayload = JSON.stringify(buildMessageCopyText(message, roleLabel))

  let contentHtml = ''
  if (message.blocks?.length) {
    contentHtml = message.blocks.map((b) => renderBlockHtml(b)).join('\n')
  } else if (message.content?.trim()) {
    contentHtml = renderMarkdownLikeHtml(message.content.trim())
  }

  // Attachments
  const attachments: string[] = []
  if (message.fileAttachments?.length) {
    attachments.push(
      `Attached files: ${message.fileAttachments.map((f) => escapeHtml(f.filename)).join(', ')}`,
    )
  }
  if (message.attachments?.length) {
    attachments.push(
      `Attached images: ${message.attachments.map((a) => escapeHtml(a.filename)).join(', ')}`,
    )
  }
  if (message.textAttachments?.length) {
    attachments.push(
      `Attached ${message.textAttachments.length} pasted text snippet(s)`,
    )
  }
  const attachmentHtml =
    attachments.length > 0
      ? `<div class="attachments muted"><i class="fa-solid fa-paperclip" aria-hidden="true"></i> ${attachments.map((a) => `<span>${a}</span>`).join('<br/>')}</div>`
      : ''

  const contentWrapper = contentHtml
    ? `<div class="assistant-prose">${contentHtml}</div>`
    : ''

  const markerHtml =
    message.variant === 'user'
      ? '<i class="fa-solid fa-user" aria-hidden="true"></i>'
      : message.variant === 'error'
        ? '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>'
        : `<img class="row-logo" src="${LOGO_DATA_URI}" alt="Savant"/>`

  return `<div class="row ${roleClass}" id="msg-${index}">
  <button type="button" class="copy-btn" title="Copy message" aria-label="Copy message" data-copy="${escapeHtml(copyPayload)}" onclick="copyMessage(this)"><i class="fa-solid fa-copy" aria-hidden="true"></i><span>Copy</span></button>
  <div class="row-head">
    <span class="row-marker">${markerHtml}</span>
    <span class="row-role">${roleLabel}</span>
  </div>
  <div class="row-content">
    ${contentWrapper}
    ${attachmentHtml}
  </div>
</div>`
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

const EXPORT_CSS = `
  :root {
    /* Neon Slate palette (theme-system.ts dark) */
    --bg: #050508;
    --surface: #0a0a0b;
    --surface-2: #0f172a;
    --surface-3: #1a1a24;
    --border: #1e293b;
    --border-soft: #181818;
    --border-user: #26324a;
    --fg: #e2e8f0;
    --fg-2: #a1a1aa;
    --muted: #64748b;
    --muted-2: #8a94a8;
    --brand: #18faf9;
    --brand-dim: #18faf933;
    --success: #39ff14;
    --error: #ff2d55;
    --warning: #ff9500;
    /* Accent family — cyan only (no purple accents) */
    --accent: #18faf9;
    --accent-light: #9ffbfa;
    --code: #7ad4d6;
    --link: #7ad4d6;
    --tool-badge: #18faf9;
    --tool-badge-fg: #06282a;
    --reasoning: #8a94a8;
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 14px;
    line-height: 1.6;
  }

  .page {
    position: relative;
    width: 100%;
    padding: 48px 32px 96px;
  }

  .corner {
    position: absolute;
    width: 8px;
    height: 8px;
    background: var(--bg);
    border: 1px solid var(--border);
  }
  .corner-tl { top: 0; left: 0; transform: translate(-4px, -4px); }
  .corner-tr { top: 0; right: 0; transform: translate(4px, -4px); }
  .corner-bl { bottom: 0; left: 0; transform: translate(-4px, 4px); }
  .corner-br { bottom: 0; right: 0; transform: translate(4px, 4px); }

  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-bottom: 16px;
  }

  .logo {
    width: 56px;
    height: 56px;
    display: block;
    filter: drop-shadow(0 0 12px var(--brand-dim));
  }

  .brand-version {
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .header {
    border-bottom: 1px dashed var(--border-soft);
    padding-bottom: 24px;
    margin-bottom: 32px;
  }

  .header h1 {
    font-size: 20px;
    font-weight: 500;
    margin: 0;
    text-align: center;
  }

  .header .brand-tag {
    color: var(--brand);
  }

  .meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px 24px;
    margin: 0;
    font-size: 12px;
    text-align: center;
  }

  .meta dt {
    color: var(--fg-2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 2px;
  }

  .meta dd {
    margin: 0;
    color: var(--accent-light);
    word-break: break-all;
  }

  .toolbar {
    display: flex;
    gap: 8px;
    margin-top: 20px;
    justify-content: center;
  }

  .toolbar button {
    font-family: inherit;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: transparent;
    color: var(--fg-2);
    border: 1px solid var(--border);
    border-radius: 0;
    padding: 6px 12px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: color 0.15s ease, border-color 0.15s ease;
  }

  .toolbar button:hover {
    color: var(--accent-light);
    border-color: var(--accent);
  }

  .transcript {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .row {
    border: 1px solid var(--border-soft);
    background: var(--surface);
    position: relative;
  }

  .copy-btn {
    position: absolute;
    bottom: 8px;
    right: 12px;
    font-family: inherit;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 0;
    padding: 2px 8px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    z-index: 1;
    transition: color 0.15s ease, border-color 0.15s ease;
  }

  .copy-btn:hover {
    color: var(--brand);
    border-color: var(--brand);
  }

  .row-user {
    padding: 12px 16px;
    border-color: var(--border-user);
    background: #0d0c16;
  }

  .row-error {
    padding: 12px 16px;
    border-color: #2a1515;
    background: #170d0d;
  }

  .row-assistant {
    padding: 12px 16px;
    border-color: var(--border-soft);
  }

  .row-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .row-marker {
    color: var(--accent);
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    line-height: 1;
  }

  .row-logo {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    display: block;
  }

  .row-error .row-marker {
    color: var(--error);
  }

  .row-role {
    display: inline-block;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .row-user .row-role { color: var(--link); }
  .row-error .row-role { color: var(--error); }
  .row-assistant .row-role { color: var(--brand); }

  .assistant-prose p { margin: 0 0 12px; }
  .assistant-prose p:last-child { margin-bottom: 0; }
  .assistant-prose h1, .assistant-prose h2, .assistant-prose h3,
  .assistant-prose h4, .assistant-prose h5, .assistant-prose h6 {
    color: var(--accent);
    margin: 16px 0 8px;
  }
  .assistant-prose ul, .assistant-prose ol { margin: 0 0 12px; padding-left: 22px; }
  .assistant-prose li { margin-bottom: 4px; }
  .assistant-prose code {
    background: #15151f;
    color: var(--code);
    padding: 1px 5px;
    font-size: 0.9em;
  }
  .assistant-prose pre {
    background: #0d0d12;
    border: 1px solid var(--border);
    padding: 12px;
    overflow-x: auto;
    margin: 0 0 12px;
  }
  .assistant-prose pre code { background: none; padding: 0; color: var(--code); }
  .assistant-prose a { color: var(--link); }
  .assistant-prose blockquote {
    border-left: 3px solid var(--accent);
    padding-left: 12px;
    margin: 0 0 12px;
    color: var(--fg-2);
    font-style: italic;
  }
  .assistant-prose hr {
    border: none;
    border-top: 1px solid var(--border-soft);
    margin: 12px 0;
  }

  .row-tool, .row-thinking {
    padding: 0;
    cursor: pointer;
  }

  .row-tool summary, .row-thinking summary {
    list-style: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    user-select: none;
  }

  .row-tool summary::-webkit-details-marker,
  .row-thinking summary::-webkit-details-marker { display: none; }

  .row-tool summary::before, .row-thinking summary::before {
    content: '\\25b8';
    color: var(--muted);
    transition: transform 0.15s ease;
  }
  .row-tool[open] summary::before, .row-thinking[open] summary::before {
    transform: rotate(90deg);
  }

  .tool-badge {
    background: var(--tool-badge);
    color: var(--tool-badge-fg);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    padding: 2px 8px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .tool-badge .fa-terminal { font-size: 0.85em; }

  .tool-input {
    color: var(--muted-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-body {
    border-top: 1px solid var(--border-soft);
    padding: 12px 16px;
  }

  .tool-output {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--muted-2);
    font-size: 13px;
  }

  .tool-body-empty { color: var(--muted); font-style: italic; }

  .thinking-badge {
    color: var(--accent-light);
    font-style: italic;
    font-size: 12px;
  }

  .thinking-icon { color: var(--accent); font-size: 0.85em; }

  .thinking-body {
    border-top: 1px solid var(--border-soft);
    padding: 12px 16px;
  }

  .thinking-body pre {
    margin: 0;
    white-space: pre-wrap;
    color: var(--reasoning);
    font-style: italic;
    font-size: 13px;
  }

  .tool-block {
    border: 1px solid var(--border);
    background: var(--surface);
    margin: 8px 0;
    padding: 10px 12px;
  }

  .tool-header { margin-bottom: 6px; }

  .tool-block details { margin-top: 6px; }

  .tool-block summary {
    cursor: pointer;
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .tool-block summary:hover { color: var(--fg-2); }

  .tool-block pre {
    background: #0d0d12;
    border: 1px solid var(--border);
    padding: 10px;
    overflow-x: auto;
    margin: 6px 0 0;
    color: var(--code);
    font-size: 12px;
  }

  .agent-block {
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    padding: 10px 12px;
    margin: 8px 0;
  }

  .agent-header {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent);
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .plan-block {
    border: 1px solid var(--border);
    border-left: 3px solid var(--success);
    padding: 10px 12px;
    margin: 8px 0;
  }

  .plan-header {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--success);
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ask-user-block {
    border: 1px solid var(--border);
    border-left: 3px solid var(--warning);
    padding: 10px 12px;
    margin: 8px 0;
  }

  .ask-user-question { margin-bottom: 8px; }
  .ask-user-question:last-child { margin-bottom: 0; }

  .muted { color: var(--muted); font-size: 0.85em; }

  .attachments {
    margin-top: 8px;
    padding: 8px;
    background: var(--surface-3);
    font-size: 12px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .inline-image {
    max-width: 100%;
    display: block;
    margin-top: 10px;
    border: 1px solid var(--border);
  }

  .footer {
    margin-top: 48px;
    padding-top: 24px;
    border-top: 1px dashed var(--border-soft);
    color: var(--muted);
    font-size: 12px;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .footer .brand {
    color: var(--brand);
    font-weight: 700;
  }

  @media (max-width: 600px) {
    .page { padding: 24px 16px 64px; }
    .toolbar { flex-direction: column; align-items: stretch; }
    .toolbar button { justify-content: center; }
  }
`

function buildExportHtml(
  messages: ChatMessage[],
  sessionId: string,
  product: string,
  brandName: string,
  version: string,
): string {
  const now = new Date()
  const timestamp = formatExportTimestamp(now)
  const rowsHtml = messages.map((m, i) => renderMessageHtml(m, i)).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${brandName} Session Export</title>
<style>
${FONT_AWESOME_ALL_CSS}
</style>
<style>
${EXPORT_CSS}
</style>
<script>
// Shared clipboard writer. navigator.clipboard needs a secure context
// (https/localhost); for a file:// export, fall back to the legacy
// execCommand textarea path.
function writeClipboard(text, done) {
  function legacyCopy() {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      done(document.execCommand('copy'))
    } catch (e) {
      done(false)
    }
    document.body.removeChild(ta)
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(function () { done(true) }, legacyCopy)
  } else {
    legacyCopy()
  }
}

function flashCopied(btn, ok) {
  var original = btn.innerHTML
  btn.innerHTML = ok
    ? '<i class="fa-solid fa-check" aria-hidden="true"></i><span>Copied</span>'
    : '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>Copy failed</span>'
  setTimeout(function () { btn.innerHTML = original }, 1600)
}

function copyMessage(btn) {
  writeClipboard(JSON.parse(btn.getAttribute('data-copy')), function (ok) {
    flashCopied(btn, ok)
  })
}

function copyAll(btn) {
  var texts = []
  var buttons = document.querySelectorAll('.copy-btn')
  for (var i = 0; i < buttons.length; i++) {
    texts.push(JSON.parse(buttons[i].getAttribute('data-copy')))
  }
  writeClipboard(texts.join('\\n\\n'), function (ok) {
    flashCopied(btn, ok)
  })
}
</script>
</head>
<body>
<div class="page">
<span class="corner corner-tl"></span>
<span class="corner corner-tr"></span>
<span class="corner corner-bl"></span>
<span class="corner corner-br"></span>

<header class="header">
  <div class="brand">
    <img class="logo" src="${LOGO_DATA_URI}" alt="${brandName} logo"/>
    <h1><span class="brand-tag">${brandName}</span></h1>
    <span class="brand-version">v${escapeHtml(version.replace(/^v/i, ''))}</span>
  </div>
  <dl class="meta">
    <div><dt>Session</dt><dd>${escapeHtml(sessionId)}</dd></div>
    <div><dt>Exported</dt><dd>${escapeHtml(timestamp)}</dd></div>
    <div><dt>Messages</dt><dd>${messages.length}</dd></div>
    <div><dt>Generated by</dt><dd>${brandName}</dd></div>
  </dl>
  <div class="toolbar">
    <button type="button" onclick="document.querySelectorAll('details').forEach(function(d){d.open=true;})"><i class="fa-solid fa-angles-down" aria-hidden="true"></i> Expand all</button>
    <button type="button" onclick="document.querySelectorAll('details').forEach(function(d){d.open=false;})"><i class="fa-solid fa-angles-up" aria-hidden="true"></i> Collapse all</button>
    <button type="button" onclick="copyAll(this)"><i class="fa-solid fa-copy" aria-hidden="true"></i> Copy all</button>
  </div>
</header>

<main class="transcript">
${rowsHtml}
</main>

<footer class="footer">
  <p>Exported from <span class="brand">${brandName}</span> · ${escapeHtml(timestamp)}</p>
  <p style="margin-top: 4px;">${brandName} — AI coding assistant powered by the ECHO Protocol</p>
</footer>
</div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export async function handleExportConversationCommand(
  params: RouterParams,
  args: string,
): Promise<void> {
  const messages = useChatStore.getState().messages
  const sessionId = useChatStore.getState().chatSessionId

  params.saveToHistory(params.inputValue.trim())
  params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })

  if (messages.length === 0) {
    params.setMessages((prev) => [
      ...prev,
      getSystemMessage('Nothing to export — the conversation is empty.'),
    ])
    return
  }

  const product = IS_SAVANT_FREE ? 'SavantFree' : 'SavantCode'
  const brandName = IS_SAVANT_FREE ? 'Savant Free' : 'Savant Code'

  // Determine output path
  const argPath = args.trim()
  let outputPath: string
  if (argPath) {
    // Use provided path — resolve relative to CWD
    outputPath = path.isAbsolute(argPath)
      ? argPath
      : path.resolve(process.cwd(), argPath)
  } else {
    // Auto-generate filename
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    outputPath = path.resolve(process.cwd(), `savant-export-${ts}.html`)
  }

  // Generate HTML
  const html = buildExportHtml(messages, sessionId, product, brandName, getVersion())

  try {
    // Ensure parent directory exists
    const dir = path.dirname(outputPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(outputPath, html, 'utf8')

    const sizeKb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)
    const msgCount = messages.length
    params.setMessages((prev) => [
      ...prev,
      getSystemMessage(
        `✅ Exported ${msgCount} message${msgCount === 1 ? '' : 's'} to **${outputPath}** (${sizeKb} KB)\n\nOpen in a browser to view the full transcript with collapsible tool calls and the Savant session report.`,
      ),
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Sanitize: never let raw filesystem paths leak secrets
    params.setMessages((prev) => [
      ...prev,
      getSystemMessage(`❌ Failed to export: ${msg}`),
    ])
  }
}
