import { describe, expect, test } from 'bun:test'

import { getProviderPickerHeight } from '../provider-picker'

describe('getProviderPickerHeight', () => {
  test('allocates one row for every provider plus the bordered header/footer space', () => {
    expect(getProviderPickerHeight(6)).toBe(8)
  })

  test('never returns a height smaller than the picker frame', () => {
    expect(getProviderPickerHeight(0)).toBe(2)
    expect(getProviderPickerHeight(-4)).toBe(2)
    expect(getProviderPickerHeight(Number.NaN)).toBe(2)
    expect(getProviderPickerHeight(Number.POSITIVE_INFINITY)).toBe(2)
  })
})
