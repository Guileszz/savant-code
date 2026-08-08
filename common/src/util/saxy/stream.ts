/**
 * This is a modified version of the Saxy library that emits text nodes immediately
 */
import { Transform } from 'node:stream'
import { StringDecoder } from 'string_decoder'

import { findIndexOutside, parseAttrs, parseEntities } from './parse'
import { TagProcessor } from './tag-processor'
import { Node } from './types'

import type {
  NextFunction,
  SaxyEventNames,
  SaxyEvents,
  TagSchema,
} from './types'

/**
 * Typed event listener methods, merged onto the Saxy class.
 */
export interface Saxy {
  on<U extends SaxyEventNames>(event: U, listener: SaxyEvents[U]): this
  once<U extends SaxyEventNames>(event: U, listener: SaxyEvents[U]): this
}

/**
 * Parse an XML stream and emit events corresponding
 * to the different tokens encountered.
 */
export class Saxy extends Transform {
  private _decoder: StringDecoder
  private _tags: TagProcessor
  private _waiting: { token: string; data: unknown } | null
  private _textBuffer: string // NEW: Text buffer as class member
  private _shouldParseEntities: boolean

  /**
   * Parse a string of XML attributes to a map of attribute names
   * to their values
   *
   * @param input A string of XML attributes
   * @throws If the string is malformed
   * @return A map of attribute names to their values
   */
  static parseAttrs = parseAttrs

  /**
   * Expand a piece of XML text by replacing all XML entities
   * by their canonical value. Ignore invalid and unknown
   * entities
   *
   * @param input A string of XML text
   * @return The input string, expanded
   */
  static parseEntities = parseEntities

  /**
   * Create a new parser instance.
   * @param schema Optional schema defining allowed top-level tags and their children
   */
  constructor(schema?: TagSchema, shouldParseEntities: boolean = true) {
    super({ decodeStrings: false, defaultEncoding: 'utf8' })

    this._decoder = new StringDecoder('utf8')

    // Stack of tags that were opened up until the current cursor position
    this._tags = new TagProcessor(schema || null, (event, data) =>
      this.emit(event, data),
    )

    // Not waiting initially
    this._waiting = null

    // Initialize text buffer
    this._textBuffer = ''

    this._shouldParseEntities = shouldParseEntities
  }

  /**
   * Handle a chunk of data written into the stream.
   *
   * @param chunk Chunk of data.
   * @param encoding Encoding of the string, or 'buffer'.
   * @param callback Called when the chunk has been parsed, with
   * an optional error argument.
   */
  public _write(
    chunk: Buffer | string,
    encoding: string,
    callback: NextFunction,
  ) {
    const data =
      encoding === 'buffer'
        ? this._decoder.write(chunk as Buffer)
        : (chunk as string)

    this._parseChunk(data, callback)
  }

  /**
   * Handle the end of incoming data.
   *
   * @param callback
   */
  public _final(callback: NextFunction) {
    // Make sure all data has been extracted from the decoder
    this._parseChunk(this._decoder.end(), (err?: Error) => {
      if (err) {
        callback(err)
        return
      }

      // Handle any remaining text buffer
      this._flushTextBuffer()

      // Handle unclosed nodes
      if (this._handleUnclosedNodes(callback)) {
        return
      }

      if (this._tags.stack.length !== 0) {
        // Unclosed tags are accepted silently (lenient tool-call parsing).
        return
      }

      callback()
    })
  }

  /**
   * Immediately parse a complete chunk of XML and close the stream.
   *
   * @param input Input chunk.
   */
  public parse(input: Buffer | string): this {
    this.end(input)
    return this
  }

  /**
   * Put the stream into waiting mode, which means we need more data
   * to finish parsing the current token.
   *
   * @param token Type of token that is being parsed.
   * @param data Pending data.
   */
  private _wait(token: string, data: unknown) {
    this._waiting = { token, data }
  }

  /**
   * Put the stream out of waiting mode.
   *
   * @return Any data that was pending.
   */
  private _unwait() {
    if (this._waiting === null) {
      return ''
    }

    const data = this._waiting.data
    this._waiting = null
    return data
  }

  /**
   * Emit any buffered text node, clearing the buffer.
   */
  private _flushTextBuffer() {
    if (this._textBuffer.length === 0) {
      return
    }

    const parsedText = this._shouldParseEntities
      ? parseEntities(this._textBuffer)
      : this._textBuffer
    this.emit(Node.text, { contents: parsedText })
    this._textBuffer = ''
  }

  /**
   * Handle any node that was left unclosed at the end of the stream.
   *
   * @param callback Completion callback for error reporting.
   * @return true if the finalization is complete (callback was invoked or
   * the unclosed node was accepted silently).
   */
  private _handleUnclosedNodes(callback: NextFunction): boolean {
    if (this._waiting === null) {
      return false
    }

    switch (this._waiting.token) {
      case Node.text:
        // Text nodes are implicitly closed
        this.emit('text', { contents: this._waiting.data })
        return false
      case Node.cdata:
        callback(new Error('Unclosed CDATA section'))
        return true
      case Node.comment:
        callback(new Error('Unclosed comment'))
        return true
      case Node.processingInstruction:
        callback(new Error('Unclosed processing instruction'))
        return true
      case Node.tagOpen:
      case Node.tagClose:
        // We do not distinguish between unclosed opening or unclosed
        // closing tags — accepted silently (lenient tool-call parsing).
        return true
      default:
        return false
    }
  }

  /**
   * Parse a XML chunk.
   *
   * @private
   * @param input A string with the chunk data.
   * @param callback Called when the chunk has been parsed, with
   * an optional error argument.
   */
  private _parseChunk(input: string, callback: NextFunction) {
    // Use pending data if applicable and get out of waiting mode
    const waitingData = this._unwait()
    input = waitingData + input

    let chunkPos = 0
    const end = input.length

    while (chunkPos < end) {
      if (
        input[chunkPos] !== '<' ||
        (chunkPos + 1 < end && !this._isXMLTagStart(input, chunkPos + 1))
      ) {
        chunkPos = this._handleText(input, chunkPos, end)
        if (chunkPos >= end) {
          break
        }
      }

      // Invariant: the cursor now points on the name of a tag,
      // after an opening angled bracket
      chunkPos += 1

      // Recognize regular tags (< ... >)
      const tagClose = findIndexOutside(
        input,
        (char: string) => char === '>',
        '"',
        chunkPos,
      )

      if (tagClose === -1) {
        this._wait(Node.tagOpen, input.slice(chunkPos - 1))
        break
      }

      // Check if the tag is a closing tag
      if (input[chunkPos] === '/') {
        chunkPos = this._tags.handleTagClosing(input, chunkPos, tagClose)
        continue
      }

      chunkPos = this._tags.handleTagOpeningAt(input, chunkPos, tagClose)
    }

    // Emit any buffered text at the end of the chunk if there's no pending entity
    this._flushTextBuffer()

    callback()
  }

  /**
   * Handle a run of text, buffering it and optionally splitting off
   * an incomplete entity at the end for the next chunk.
   *
   * @param input The input string.
   * @param chunkPos Position of the first text character.
   * @param end End of the input string.
   * @return The new cursor position (the next tag start, or `end` if the
   * rest of the chunk is text).
   */
  private _handleText(input: string, chunkPos: number, end: number): number {
    // Find next potential tag, but verify it's actually a tag
    let nextTag = input.indexOf('<', chunkPos)
    while (
      nextTag !== -1 &&
      nextTag + 1 < end &&
      !this._isXMLTagStart(input, nextTag + 1)
    ) {
      nextTag = input.indexOf('<', nextTag + 1)
    }

    // We read a TEXT node but there might be some
    // more text data left, so we wait
    if (nextTag === -1) {
      let chunk = input.slice(chunkPos)

      if (this._tags.stack.length === 1 && !chunk.trim()) {
        chunk = ''
      }

      // Check for incomplete entity at end
      const lastAmp = chunk.lastIndexOf('&')
      if (
        this._shouldParseEntities &&
        lastAmp !== -1 &&
        chunk.indexOf(';', lastAmp) === -1
      ) {
        // Only consider it a pending entity if it looks like the start of one
        const postAmp = chunk.slice(lastAmp + 1)
        const isPotentialEntity =
          /^(#\d*)?$/.test(postAmp) || // Numeric entity
          /^[a-zA-Z]{0,6}$/.test(postAmp) // Named entity
        if (isPotentialEntity) {
          // Store incomplete entity for next chunk
          this._wait(Node.text, chunk.slice(lastAmp))
          chunk = chunk.slice(0, lastAmp)
        }
      }

      if (chunk.length > 0) {
        this._textBuffer += chunk
      }

      return end
    }

    // A tag follows, so we can be confident that
    // we have all the data needed for the TEXT node
    let chunk = input.slice(chunkPos, nextTag)

    if (this._tags.stack.length === 1 && !chunk.trim()) {
      chunk = ''
    }

    // Only emit non-whitespace text or text within a single tag (not between tags)
    if (chunk.length > 0) {
      this._textBuffer += chunk
    }

    // We've reached a tag boundary, emit any buffered text
    this._flushTextBuffer()

    return nextTag
  }

  /**
   * Check if a potential XML tag start is actually a valid tag
   * @param input The input string
   * @param pos Position after the < character
   * @returns true if this is a valid XML tag start
   */
  private _isXMLTagStart(input: string, pos: number): boolean {
    // Valid XML tags must start with a letter, underscore or colon
    // https://www.w3.org/TR/xml/#NT-NameStartChar
    const firstChar = input[pos]
    return /[A-Za-z_:]/.test(firstChar) || firstChar === '/'
  }
}
