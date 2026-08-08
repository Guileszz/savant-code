import { useCallback, useEffect, useRef, useState } from 'react'

import { getOptionLabel, CUSTOM_OPTION_INDEX } from './constants'
import { useChatStore } from '../../state/chat-store'

import type { AccordionAnswer } from './components/accordion-question'
import type { AskUserQuestion } from '../../types/store'

/** Everything the render + keyboard layers need, computed from the questions
 *  and the store's focus state. Kept out of the component so the JSX shell
 *  stays under the 400-line bar. */
export interface MultipleChoiceFormState {
  terminalFocused: boolean
  suppressNextHoverFocusRef: React.MutableRefObject<boolean>
  expandedIndex: number | null
  setExpandedIndex: React.Dispatch<React.SetStateAction<number | null>>
  answers: Map<number, AccordionAnswer>
  focusedOptionIndex: number | null
  setFocusedOptionIndex: React.Dispatch<React.SetStateAction<number | null>>
  focusedQuestionIndex: number
  setFocusedQuestionIndex: React.Dispatch<React.SetStateAction<number>>
  submitFocused: boolean
  setSubmitFocused: React.Dispatch<React.SetStateAction<boolean>>
  submitHovered: boolean
  setSubmitHovered: React.Dispatch<React.SetStateAction<boolean>>
  showFocusHighlight: boolean
  setShowFocusHighlight: React.Dispatch<React.SetStateAction<boolean>>
  lastFocusBeforeSubmit: {
    questionIndex: number
    optionIndex: number
  } | null
  isTypingCustom: boolean
  setIsTypingCustom: React.Dispatch<React.SetStateAction<boolean>>
  customCursorPositions: Map<number, number>
  openQuestion: (questionIndex: number, optionIndex: number) => void
  focusSubmit: (from?: { questionIndex: number; optionIndex: number }) => void
  handleSetCustomText: (
    questionIndex: number,
    text: string,
    cursorPosition: number,
  ) => void
  handleCustomSubmit: (questionIndex: number) => void
  handleSelectOption: (
    questionIndex: number,
    optionIndex: number,
    source?: 'keyboard' | 'mouse',
  ) => void
  handleToggleOption: (questionIndex: number, optionIndex: number) => void
  formatAnswer: (
    question: AskUserQuestion,
    answer: AccordionAnswer | undefined,
  ) => { question: string; answer: string }
  handleSubmit: () => void
}

export function useMultipleChoiceFormState(opts: {
  questions: AskUserQuestion[]
  onSubmit: (answers: { question: string; answer: string }[]) => void
}): MultipleChoiceFormState {
  const { questions, onSubmit } = opts
  const terminalFocused = useChatStore((state) => state.inputFocused)
  const suppressNextHoverFocusRef = useRef(false)

  // Track which question is currently expanded (null = none)
  const [expandedIndex, setExpandedIndex] = useState<number | null>(
    questions.length > 0 ? 0 : null,
  )

  // Track answers for each question
  const [answers, setAnswers] = useState<Map<number, AccordionAnswer>>(
    new Map(),
  )

  // Track focused option within expanded question
  const [focusedOptionIndex, setFocusedOptionIndex] = useState<number | null>(
    questions.length > 0 ? 0 : null,
  )

  // Track which question has keyboard focus
  const [focusedQuestionIndex, setFocusedQuestionIndex] = useState<number>(0)

  // Track if submit button has focus (Tab navigation)
  const [submitFocused, setSubmitFocused] = useState<boolean>(false)

  const [submitHovered, setSubmitHovered] = useState<boolean>(false)

  const [showFocusHighlight, setShowFocusHighlight] = useState<boolean>(true)

  const [lastFocusBeforeSubmit, setLastFocusBeforeSubmit] = useState<{
    questionIndex: number
    optionIndex: number
  } | null>(null)

  // Track if user is typing in "Custom" text input
  const [isTypingCustom, setIsTypingCustom] = useState<boolean>(false)

  // Track cursor position for "Custom" text input (per question)
  const [customCursorPositions, setCustomCursorPositions] = useState<
    Map<number, number>
  >(new Map())

  const setAnswerForQuestion = useCallback(
    (
      questionIndex: number,
      updater: (previous: AccordionAnswer | undefined) => AccordionAnswer,
    ) => {
      setAnswers((prev) => {
        const nextAnswers = new Map(prev)
        const previousAnswer = prev.get(questionIndex) ?? {}
        nextAnswers.set(questionIndex, updater(previousAnswer))
        return nextAnswers
      })
    },
    [],
  )

  const openQuestion = useCallback(
    (questionIndex: number, optionIndex: number) => {
      setExpandedIndex(questionIndex)
      setFocusedQuestionIndex(questionIndex)
      setFocusedOptionIndex(optionIndex)
      setSubmitFocused(false)
      setIsTypingCustom(false)
    },
    [],
  )

  const focusSubmit = useCallback(
    (from?: { questionIndex: number; optionIndex: number }) => {
      const optionIndex = from?.optionIndex ?? focusedOptionIndex ?? 0
      const questionIndex = from?.questionIndex ?? focusedQuestionIndex
      setLastFocusBeforeSubmit({ questionIndex, optionIndex })
      setSubmitFocused(true)
      setIsTypingCustom(false)
    },
    [focusedOptionIndex, focusedQuestionIndex],
  )

  // Handle setting "Custom" text (with cursor position)
  const handleSetCustomText = useCallback(
    (questionIndex: number, text: string, cursorPosition: number) => {
      setAnswerForQuestion(questionIndex, (currentAnswer) => ({
        ...currentAnswer,
        isCustom: true,
        customText: text,
      }))
      setCustomCursorPositions((prev) => {
        const newPositions = new Map(prev)
        newPositions.set(questionIndex, cursorPosition)
        return newPositions
      })
    },
    [setAnswerForQuestion],
  )

  // Handle "Custom" text submit (Enter key)
  const handleCustomSubmit = useCallback(
    (questionIndex: number) => {
      setIsTypingCustom(false)
      setSubmitFocused(false)

      if (questions[questionIndex]?.multiSelect) {
        return
      }

      if (questionIndex < questions.length - 1) {
        openQuestion(questionIndex + 1, 0)
        return
      }

      focusSubmit({
        questionIndex,
        optionIndex: questions[questionIndex]?.options.length ?? 0,
      })
    },
    [questions, openQuestion, focusSubmit],
  )

  // Handle selecting an option (single-select)
  const handleSelectOption = useCallback(
    (
      questionIndex: number,
      optionIndex: number,
      source: 'keyboard' | 'mouse' = 'keyboard',
    ) => {
      setSubmitFocused(false)
      const isCustomOption = optionIndex === CUSTOM_OPTION_INDEX

      // When clicking out of Custom typing mode, first click just exits and highlights
      // the option without selecting it (requires a second click to actually select)
      if (source === 'mouse' && isTypingCustom && !isCustomOption) {
        setIsTypingCustom(false)
        setFocusedOptionIndex(optionIndex)
        setShowFocusHighlight(true)
        // Deselect Custom option but preserve the typed text
        setAnswerForQuestion(questionIndex, (currentAnswer) => ({
          ...currentAnswer,
          isCustom: false,
        }))
        return
      }

      if (source === 'mouse' && !isCustomOption) {
        setShowFocusHighlight(false)
        suppressNextHoverFocusRef.current = true
      }

      setAnswerForQuestion(questionIndex, (currentAnswer) =>
        isCustomOption
          ? {
              // Selecting "Custom" should clear any single-select choice
              selectedIndex: undefined,
              selectedIndices: undefined,
              isCustom: true,
              customText: currentAnswer?.customText || '',
            }
          : {
              selectedIndex: optionIndex,
              selectedIndices: undefined,
              isCustom: false,
              customText: currentAnswer?.customText, // Preserve custom text when switching away
            },
      )

      // For "Custom" option, enter typing mode
      if (isCustomOption) {
        setFocusedQuestionIndex(questionIndex)
        setFocusedOptionIndex(questions[questionIndex]?.options.length ?? 0)
        setIsTypingCustom(true)
        return
      }

      if (questionIndex < questions.length - 1) {
        openQuestion(questionIndex + 1, 0)
        return
      }

      // For last/only question, collapse to show answer summary
      setExpandedIndex(null)
      focusSubmit({ questionIndex, optionIndex })
    },
    [
      questions,
      openQuestion,
      focusSubmit,
      setAnswerForQuestion,
      isTypingCustom,
    ],
  )

  // Handle toggling an option (multi-select)
  const handleToggleOption = useCallback(
    (questionIndex: number, optionIndex: number) => {
      setSubmitFocused(false)
      let toggledCustomOn = false

      setAnswers((prev) => {
        const newAnswers = new Map(prev)
        const currentAnswer: AccordionAnswer = prev.get(questionIndex) ?? {}

        if (optionIndex === CUSTOM_OPTION_INDEX) {
          toggledCustomOn = !(currentAnswer?.isCustom ?? false)
          newAnswers.set(questionIndex, {
            ...currentAnswer,
            selectedIndices: new Set(currentAnswer?.selectedIndices ?? []),
            isCustom: !currentAnswer?.isCustom,
            customText: currentAnswer?.customText || '',
          })
          return newAnswers
        }

        const newIndices = new Set(currentAnswer?.selectedIndices ?? [])
        if (newIndices.has(optionIndex)) {
          newIndices.delete(optionIndex)
        } else {
          newIndices.add(optionIndex)
        }
        newAnswers.set(questionIndex, {
          ...currentAnswer,
          selectedIndices: newIndices,
          isCustom: currentAnswer?.isCustom ?? false,
        })
        return newAnswers
      })

      // For "Custom" option in multi-select, also enter typing mode
      if (optionIndex === CUSTOM_OPTION_INDEX) {
        setIsTypingCustom(toggledCustomOn)
      }
    },
    [],
  )

  const formatAnswer = useCallback(
    (question: AskUserQuestion, answer: AccordionAnswer | undefined) => {
      if (!answer) {
        return { question: question.question, answer: 'Skipped' }
      }

      const selectedOptions = question.multiSelect
        ? Array.from(answer.selectedIndices ?? [])
            .map((idx) => getOptionLabel(question.options[idx]))
            .filter(Boolean)
        : answer.selectedIndex !== undefined
          ? [getOptionLabel(question.options[answer.selectedIndex])]
          : []

      const customText =
        answer.isCustom && (answer.customText?.trim().length ?? 0) > 0
          ? (answer.customText ?? '').trim()
          : ''

      const parts = customText
        ? [...selectedOptions, customText]
        : selectedOptions
      if (parts.length === 0) {
        return { question: question.question, answer: 'Skipped' }
      }

      return {
        question: question.question,
        answer: question.multiSelect ? parts.join(', ') : parts[0],
      }
    },
    [],
  )

  // Handle submit
  const handleSubmit = useCallback(() => {
    const formattedAnswers = questions.map((question, index) =>
      formatAnswer(question, answers.get(index)),
    )

    onSubmit(formattedAnswers)
  }, [questions, answers, onSubmit, formatAnswer])

  // Sync focusedQuestionIndex when expandedIndex changes
  useEffect(() => {
    if (expandedIndex !== null) {
      setFocusedQuestionIndex(expandedIndex)
    }
  }, [expandedIndex])

  useEffect(() => {
    if (!terminalFocused) {
      setSubmitHovered(false)
    }
  }, [terminalFocused])

  return {
    terminalFocused,
    suppressNextHoverFocusRef,
    expandedIndex,
    setExpandedIndex,
    answers,
    focusedOptionIndex,
    setFocusedOptionIndex,
    focusedQuestionIndex,
    setFocusedQuestionIndex,
    submitFocused,
    setSubmitFocused,
    submitHovered,
    setSubmitHovered,
    showFocusHighlight,
    setShowFocusHighlight,
    lastFocusBeforeSubmit,
    isTypingCustom,
    setIsTypingCustom,
    customCursorPositions,
    openQuestion,
    focusSubmit,
    handleSetCustomText,
    handleCustomSubmit,
    handleSelectOption,
    handleToggleOption,
    formatAnswer,
    handleSubmit,
  }
}
