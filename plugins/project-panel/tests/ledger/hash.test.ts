import { describe, expect, test } from 'claude-code/testing'
import { assignmentInputs, inputHash } from '../../src/providers/ledger/hash'

describe('inputHash', () => {
  test('is a stable 64-character hex SHA-256', async () => {
    const h = await inputHash(['a', 'b'])
    expect(h).toHaveLength(64)
    expect(h).toBe(await inputHash(['a', 'b']))
  })
  test('matches the known SHA-256 of the joined bytes', async () => {
    expect(await inputHash(['abc'])).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  test('parts are separated: ["ab","c"] differs from ["a","bc"]', async () => {
    expect(await inputHash(['ab', 'c'])).not.toBe(await inputHash(['a', 'bc']))
  })
})

describe('assignmentInputs', () => {
  test('PR numbers and directories are sorted, so order does not matter', async () => {
    const a = assignmentInputs('text', [10, 2, 33], ['src', 'docs'])
    const b = assignmentInputs('text', [33, 10, 2], ['docs', 'src'])
    expect(a).toEqual(b)
    expect(a).toEqual(['text', '2,10,33', 'docs,src'])
  })
  test('PR numbers sort numerically, not as text', () => {
    expect(assignmentInputs('t', [9, 10], [])[1]).toBe('9,10')
  })
  test('a changed ledger or a new merged PR changes the hash', async () => {
    const base = await inputHash(assignmentInputs('text', [1], ['src']))
    expect(await inputHash(assignmentInputs('text!', [1], ['src']))).not.toBe(base)
    expect(await inputHash(assignmentInputs('text', [1, 2], ['src']))).not.toBe(base)
    expect(await inputHash(assignmentInputs('text', [1], ['src', 'docs']))).not.toBe(base)
  })
  test('pinned section ids join the parts only when given', () => {
    expect(assignmentInputs('t', [], [], ['b', 'a'])).toEqual(['t', '', '', 'a,b'])
    expect(assignmentInputs('t', [], [])).toHaveLength(3)
  })
})
