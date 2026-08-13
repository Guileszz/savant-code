import { AskUserBridge } from '@savant-code/common/utils/ask-user-bridge'

import { clearInput, defineCommandWithArgs } from './command-shared'
import {
  clearCustomDesignDraft,
  discardCustomDesignDraft,
  getCustomDesignDraft,
  importCustomDesignSystem,
  listCustomDesignDrafts,
  listDesignSystems,
  resolveCurrentDesignSystem,
  resolveDesignSystemReference,
  resetDesignSystemSelection,
  saveCustomDesignDraft,
  saveCustomDesignSystem,
  setDesignSystemSelection,
  validateDesignInput,
} from '../utils/design-system-service'
import { getSystemMessage } from '../utils/message-history'

import type { RouterParams } from './command-shared'
import type {
  DesignAuthoringInputV1,
  DesignSystemResource,
} from '@savant-code/design-systems'

type Answer = {
  questionIndex: number
  selectedOption?: string
  selectedOptions?: string[]
  otherText?: string
}

type AskResponse = { answers?: Answer[]; skipped?: boolean }

function answerText(response: AskResponse, index: number): string {
  const answer = response.answers?.find((item) => item.questionIndex === index)
  return answer?.otherText?.trim() ?? answer?.selectedOption?.trim() ?? ''
}

function answerOptions(response: AskResponse, index: number): string[] {
  return (
    response.answers?.find((item) => item.questionIndex === index)
      ?.selectedOptions ?? []
  )
}

function parseMap(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/,(?=\s*[^,{]+\s*=)/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=')
        const key = separator >= 0 ? part.slice(0, separator).trim() : ''
        const item = separator >= 0 ? part.slice(separator + 1).trim() : ''
        return [key, item.replace(/^"|"$/g, '')]
      })
      .filter(([key, item]) => key.length > 0 && item.length > 0),
  )
}

function formatMap(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, item]) => `${key}=${JSON.stringify(item)}`)
    .join(', ')
}

function parseNestedMap(
  value: string,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(parseMap(value)).flatMap(([key, item]) => {
      try {
        const parsed: unknown = JSON.parse(item)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? [[key, parsed as Record<string, unknown>]]
          : []
      } catch {
        return []
      }
    }),
  )
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function parseScopedValue(values: string[]): {
  value: string
  scope: 'project' | 'user'
} {
  const scope = values.includes('--user') ? 'user' : 'project'
  return {
    scope,
    value: values.filter((item) => item !== '--user').join(' '),
  }
}

function draftSeed(existing?: DesignAuthoringInputV1): DesignAuthoringInputV1 {
  return (
    existing ?? {
      schemaVersion: '1',
      id: 'custom-design-system',
      displayName: 'Custom Design System',
      description: 'A custom design system draft.',
      scope: 'project',
      targets: ['terminal', 'react'],
      colors: { primary: '#00d4ff' },
      typography: { body: { fontFamily: 'system-ui, sans-serif' } },
      spacing: { sm: '8px' },
      radius: { sm: '4px' },
      components: {},
      accessibility: { contrastReview: true },
      activate: false,
    }
  )
}

function resourceToAuthoringInput(
  resource: DesignSystemResource,
  scope: 'project' | 'user',
  cloneBuiltIn = false,
): DesignAuthoringInputV1 {
  let id = resource.id
  if (cloneBuiltIn) {
    id = `${resource.id}-custom`
    let suffix = 2
    while (resolveDesignSystemReference(id, scope)) {
      id = `${resource.id}-custom-${suffix}`
      suffix += 1
    }
  }
  return {
    schemaVersion: '1',
    id,
    displayName: resource.displayName,
    description: resource.description,
    scope,
    targets: resource.targets,
    colors: resource.tokens.colors,
    typography: resource.tokens.typography,
    spacing: resource.tokens.spacing,
    radius: resource.tokens.radius,
    components: resource.tokens.components,
    accessibility:
      resource.tokens.extensions.accessibility &&
      typeof resource.tokens.extensions.accessibility === 'object'
        ? (resource.tokens.extensions.accessibility as Record<string, unknown>)
        : {},
    activate: true,
    provenance: resource.provenance,
  }
}

function questionsFor(
  existing?: DesignAuthoringInputV1,
): Parameters<typeof AskUserBridge.request>[1] {
  const value = (current: string): { label: string; description: string } => ({
    label: current ? `Keep current: ${current}` : 'Enter a value',
    description:
      'Choose this to keep the current value, or type a replacement.',
  })
  return [
    {
      question: 'Stable design-system id (lowercase kebab-case)',
      header: 'Identity',
      options: [value(existing?.id ?? ''), { label: 'Choose a new id' }],
      multiSelect: false,
      validation: {
        pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
        patternError: 'Use lowercase kebab-case.',
      },
    },
    {
      question: 'Display name',
      header: 'Name',
      options: [
        value(existing?.displayName ?? ''),
        { label: 'Choose a new name' },
      ],
      multiSelect: false,
    },
    {
      question: 'Scope for this saved system',
      header: 'Scope',
      options: [
        { label: existing?.scope ?? 'project' },
        { label: existing?.scope === 'project' ? 'user' : 'project' },
      ],
      multiSelect: false,
    },
    {
      question: 'Description',
      header: 'Description',
      options: [
        value(existing?.description ?? ''),
        { label: 'Enter a description' },
      ],
      multiSelect: false,
    },
    {
      question: 'Targets',
      header: 'Targets',
      options: [{ label: 'terminal' }, { label: 'react' }, { label: 'web' }],
      multiSelect: true,
    },
    {
      question: 'Semantic colors as comma-separated key=#hex pairs',
      header: 'Colors',
      options: [
        value(formatMap(existing?.colors ?? {})),
        { label: 'Enter colors' },
      ],
      multiSelect: false,
    },
    {
      question: 'Typography as role=font-family pairs',
      header: 'Typography',
      options: [
        value(formatMap(existing?.typography ?? {})),
        { label: 'Enter typography' },
      ],
      multiSelect: false,
    },
    {
      question: 'Spacing as comma-separated key=value pairs',
      header: 'Spacing',
      options: [
        value(formatMap(existing?.spacing ?? {})),
        { label: 'Enter spacing' },
      ],
      multiSelect: false,
    },
    {
      question: 'Radius as comma-separated key=value pairs',
      header: 'Radius',
      options: [
        value(formatMap(existing?.radius ?? {})),
        { label: 'Enter radius' },
      ],
      multiSelect: false,
    },
    {
      question: 'Component guidance as role={JSON object} pairs',
      header: 'Components',
      options: [
        value(formatMap(existing?.components ?? {})),
        { label: 'Enter component guidance' },
      ],
      multiSelect: false,
    },
    {
      question: 'Accessibility requirements as a JSON object',
      header: 'Accessibility',
      options: [
        value(JSON.stringify(existing?.accessibility ?? {})),
        { label: 'Enter accessibility requirements' },
      ],
      multiSelect: false,
    },
    {
      question: 'Save this validated contract?',
      header: 'Confirm',
      options: [
        { label: 'Save and activate' },
        { label: 'Save without activating' },
        { label: 'Cancel' },
      ],
      multiSelect: false,
    },
  ]
}

function keepOrText(
  response: AskResponse,
  index: number,
  fallback: string,
  labels: string[] = [],
): string {
  const text = answerText(response, index)
  if (!text || text.startsWith('Keep current: ') || labels.includes(text)) {
    return fallback
  }
  return text
}

async function authorInteractively(
  params: RouterParams,
  existing?: DesignAuthoringInputV1,
  draftId?: string,
): Promise<boolean> {
  const response = await AskUserBridge.request(
    'design-authoring',
    questionsFor(existing),
  )
  if (response.skipped) {
    const seed = draftSeed(existing)
    try {
      const draft = saveCustomDesignDraft(seed.scope, seed, draftId)
      params.setMessages((prev) => [
        ...prev,
        getSystemMessage(
          `Design authoring cancelled; draft ${draft.id} is available via /design resume ${draft.id}. No files were changed.`,
        ),
      ])
    } catch (error) {
      params.setMessages((prev) => [
        ...prev,
        getSystemMessage(
          `Design authoring cancelled, but the draft could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ])
    }
    return false
  }

  const scopeText = answerText(response, 2)
  const scope = (
    scopeText === 'user' || scopeText === 'project'
      ? scopeText
      : (existing?.scope ?? 'project')
  ) as 'project' | 'user'
  const targets = answerOptions(response, 4).filter(
    (item): item is 'terminal' | 'react' | 'web' =>
      item === 'terminal' || item === 'react' || item === 'web',
  )
  const id = keepOrText(response, 0, existing?.id ?? '', [
    'Choose a new id',
    'Enter a value',
  ])
  const displayName = keepOrText(response, 1, existing?.displayName ?? '', [
    'Choose a new name',
    'Enter a value',
  ])
  const description = keepOrText(
    response,
    3,
    existing?.description ?? `Custom ${displayName} design system.`,
    ['Choose a new description', 'Enter a description', 'Enter a value'],
  )
  const colors = parseMap(
    keepOrText(response, 5, formatMap(existing?.colors ?? {})),
  )
  const typographyInput = parseMap(
    keepOrText(response, 6, formatMap(existing?.typography ?? {})),
  )
  const typography = Object.fromEntries(
    Object.entries(typographyInput).map(([key, value]) => {
      try {
        const parsed = JSON.parse(value)
        return [
          key,
          parsed && typeof parsed === 'object' ? parsed : { fontFamily: value },
        ]
      } catch {
        return [key, { fontFamily: value }]
      }
    }),
  )
  const input: DesignAuthoringInputV1 = {
    schemaVersion: '1',
    id,
    displayName,
    description,
    scope,
    targets:
      targets.length > 0
        ? targets
        : (existing?.targets ?? ['terminal', 'react']),
    colors,
    typography,
    spacing: parseMap(
      keepOrText(response, 7, formatMap(existing?.spacing ?? {})),
    ),
    radius: parseMap(
      keepOrText(response, 8, formatMap(existing?.radius ?? {})),
    ),
    components: parseNestedMap(
      keepOrText(response, 9, formatMap(existing?.components ?? {})),
    ),
    accessibility: parseObject(
      keepOrText(response, 10, JSON.stringify(existing?.accessibility ?? {})),
    ),
    activate: answerText(response, 11) === 'Save and activate',
    ...(existing?.provenance ? { provenance: existing.provenance } : {}),
  }

  const validation = validateDesignInput(input)
  if (!validation.ok) {
    try {
      const draft = saveCustomDesignDraft(input.scope, input, draftId)
      params.setMessages((prev) => [
        ...prev,
        getSystemMessage(
          `${validation.code}: ${validation.message} Draft ${draft.id} was saved; resume it with /design resume ${draft.id}.`,
        ),
      ])
    } catch (error) {
      params.setMessages((prev) => [
        ...prev,
        getSystemMessage(
          `${validation.code}: ${validation.message} Draft persistence also failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ])
    }
    return false
  }

  const preview = [
    `Design system: ${input.displayName} (${input.id})`,
    `Scope: ${input.scope} | Targets: ${input.targets.join(', ')}`,
    `Colors: ${Object.keys(input.colors).length} | Typography: ${Object.keys(input.typography).length} | Components: ${Object.keys(input.components).length}`,
    `Accessibility requirements: ${Object.keys(input.accessibility).length}`,
  ].join('\\n')
  const review = await AskUserBridge.request('design-authoring-review', [
    {
      question: `Review this validated design-system contract before saving:\\n\\n${preview}`,
      header: 'Review',
      options: [
        { label: 'Save and continue' },
        { label: 'Cancel and keep draft' },
      ],
      multiSelect: false,
    },
  ])
  if (review.skipped || answerText(review, 0) !== 'Save and continue') {
    try {
      const draft = saveCustomDesignDraft(input.scope, input, draftId)
      params.setMessages((prev) => [
        ...prev,
        getSystemMessage(
          `Review cancelled; draft ${draft.id} is available via /design resume ${draft.id}. No files were changed.`,
        ),
      ])
    } catch (error) {
      params.setMessages((prev) => [
        ...prev,
        getSystemMessage(
          `Review cancelled, but the draft could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ])
    }
    return false
  }

  const saved = saveCustomDesignSystem(input)
  if (draftId) clearCustomDesignDraft(input.scope, draftId)
  params.setMessages((prev) => [
    ...prev,
    getSystemMessage(
      `Saved ${saved.displayName} (${saved.id})${input.activate ? ' and activated it' : ''}.`,
    ),
  ])
  return true
}

export function isDesignCreateIntent(input: string): boolean {
  return /^(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:create|make|start)\s+(?:a|an|my)\s+(?:custom\s+design|design\s+system)[.!?]?$/i.test(
    input.trim(),
  )
}

export async function handleDesignCreateIntent(
  params: RouterParams,
): Promise<boolean> {
  if (!isDesignCreateIntent(params.inputValue)) return false
  const response = await AskUserBridge.request('design-intent-confirm', [
    {
      question: 'Open the guided custom design-system creator?',
      header: 'Design',
      options: [{ label: 'Open creator' }, { label: 'Keep chatting' }],
      multiSelect: false,
    },
  ])
  if (!response.skipped && answerText(response, 0) === 'Open creator') {
    await authorInteractively(params)
  } else {
    params.setMessages((prev) => [
      ...prev,
      getSystemMessage('No design-system changes were made.'),
    ])
  }
  clearInput(params)
  return true
}

export const DESIGN_COMMANDS = [
  defineCommandWithArgs({
    name: 'design',
    aliases: ['ds'],
    handler: async (params, args) => {
      const [subcommand = 'current', ...rest] = args.trim().split(/\s+/)
      const value = rest.join(' ')
      if (subcommand === 'list') {
        params.setMessages((prev) => [
          ...prev,
          getSystemMessage(
            listDesignSystems()
              .map(
                (item) => `${item.id} — ${item.displayName} [${item.source}]`,
              )
              .join('\n'),
          ),
        ])
      } else if (subcommand === 'current') {
        const current = resolveCurrentDesignSystem()
        params.setMessages((prev) => [
          ...prev,
          getSystemMessage(
            `Active design system: ${current.displayName} (${current.id}, ${current.selectionScope})`,
          ),
        ])
      } else if (subcommand === 'use' && value) {
        const scoped = parseScopedValue(rest)
        const resource = resolveDesignSystemReference(
          scoped.value,
          scoped.scope,
        )
        if (!resource)
          throw new Error(`Design system not found: ${scoped.value}`)
        setDesignSystemSelection(
          resource.source === 'user' ? 'user' : scoped.scope,
          resource.id,
        )
        params.setMessages((prev) => [
          ...prev,
          getSystemMessage(
            `Active design system: ${resource.displayName} (${resource.id})`,
          ),
        ])
      } else if (subcommand === 'create') {
        await authorInteractively(params)
      } else if (subcommand === 'edit' && value) {
        const scoped = parseScopedValue(rest)
        const resource = resolveDesignSystemReference(
          scoped.value,
          scoped.scope,
        )
        if (!resource)
          throw new Error(`Design system not found: ${scoped.value}`)
        const scope = resource.source === 'user' ? 'user' : scoped.scope
        await authorInteractively(
          params,
          resourceToAuthoringInput(
            resource,
            scope,
            resource.source === 'embedded',
          ),
        )
      } else if (subcommand === 'import' && rest[0]) {
        const scope = rest.includes('--user') ? 'user' : 'project'
        const sourcePath = rest.filter((item) => item !== '--user').join(' ')
        const imported = importCustomDesignSystem(sourcePath, scope, false)
        params.setMessages((prev) => [
          ...prev,
          getSystemMessage(
            `Imported ${imported.displayName} (${imported.id}).`,
          ),
        ])
      } else if (subcommand === 'validate' && value) {
        const scoped = parseScopedValue(rest)
        const resource = resolveDesignSystemReference(
          scoped.value,
          scoped.scope,
        )
        if (!resource)
          throw new Error(`Design system not found: ${scoped.value}`)
        params.setMessages((prev) => [
          ...prev,
          getSystemMessage(
            `Valid design system: ${resource.displayName} (${resource.id}).`,
          ),
        ])
      } else if (subcommand === 'drafts') {
        const scope = rest.includes('--user') ? 'user' : 'project'
        const drafts = listCustomDesignDrafts(scope)
        params.setMessages((prev) => [
          ...prev,
          getSystemMessage(
            drafts.length === 0
              ? 'No resumable design-system drafts found.'
              : drafts
                  .map((draft) => `${draft.id} — ${draft.updatedAt}`)
                  .join('\n'),
          ),
        ])
      } else if (subcommand === 'resume' && value) {
        const scoped = parseScopedValue(rest)
        const scope = scoped.scope
        const draftId = scoped.value
        const draft = getCustomDesignDraft(scope, draftId)
        if (!draft)
          throw new Error(`Design-system draft is unavailable: ${draftId}`)
        await authorInteractively(params, draft.input, draft.id)
      } else if (subcommand === 'discard' && value) {
        const scoped = parseScopedValue(rest)
        const scope = scoped.scope
        const draftId = scoped.value
        if (!discardCustomDesignDraft(scope, draftId)) {
          throw new Error(`Design-system draft is unavailable: ${draftId}`)
        }
      } else if (subcommand === 'reset') {
        const scope =
          value === '--project' || value === '--user' ? value.slice(2) : 'all'
        resetDesignSystemSelection(scope as 'project' | 'user' | 'all')
        params.setMessages((prev) => [
          ...prev,
          getSystemMessage('Design-system selection reset.'),
        ])
      } else {
        params.setMessages((prev) => [
          ...prev,
          getSystemMessage(
            'Usage: /design list | current | use <id> | create | edit <id> | import <path> [--user] | validate <id> | drafts | resume <draft-id> | discard <draft-id> | reset [--project|--user]',
          ),
        ])
      }
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
]
