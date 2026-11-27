import { describe, expect, test } from 'bun:test'
import { damageColumn, parseRow, type TextLine } from '../src/client/ocr/layout'

/**
 * The geometry rules the first 5v5 capture broke, taken from its real boxes.
 *
 * The board is 812x684: the DMG header sits over x 404-463, EDA over 557-610,
 * and each row prints its damage near x 433 and its kill count near x 538.
 */

const line = (
  text: string,
  confidence: number,
  box: [number, number, number, number],
): TextLine => ({ text, confidence, box })

const header = [
  line('DMG', 0.996, [404, 150, 463, 176]),
  line('EDA', 0.997, [557, 150, 610, 173]),
  line('PING', 0.996, [683, 150, 746, 173]),
]

const rowOne = 65
/** The gold stripe on that board merges both its players: one band, 196 px. */
const goldBand = 196

describe('the DMG column', () => {
  test('a window one row tall takes the damage and not the kill count', () => {
    const column = damageColumn(header, rowOne)
    expect(column).not.toBeNull()

    // The kill count is closer to the DMG header than the next column, so only a
    // window no taller than one row can exclude it.
    const band = damageColumn(header, goldBand)!
    expect(Math.abs(538.5 - band.center)).toBeLessThan(band.tolerance)
    expect(Math.abs(538.5 - column!.center)).toBeGreaterThan(column!.tolerance)

    const lines = [
      line('M0nkeyman23287', 0.989, [93, 351, 295, 373]),
      line('2,107', 0.998, [401, 350, 466, 373]),
      line('16', 0.999, [524, 351, 553, 372]),
    ]
    const parsed = parseRow(lines, column, rowOne)
    expect(parsed.damage).toBe(2107)
    expect(parsed.rawDamage).toBe('2,107')
  })
})

describe('a handle the recogniser split', () => {
  test('is joined back into one username', () => {
    const column = damageColumn(header, rowOne)
    const lines = [
      line('PVPDreadlord', 0.997, [92, 473, 248, 493]),
      line('@destruction_', 0.983, [92, 491, 237, 508]),
      line('lord9', 0.97, [239, 491, 292, 508]),
      line('929', 1, [411, 482, 459, 501]),
      line('5', 0.998, [531, 482, 548, 501]),
    ]

    const parsed = parseRow(lines, column, rowOne)
    expect(parsed.username).toBe('destruction_lord9')
    // The display name above the handle is a different printed line.
    expect(parsed.username).not.toContain('PVPD')
    expect(parsed.damage).toBe(929)
  })

  test('is left alone when nothing follows the handle', () => {
    const column = damageColumn(header, rowOne)
    const lines = [
      line('Burrito', 1, [92, 407, 175, 429]),
      line('@TyggrGMR', 0.99, [92, 427, 179, 445]),
      line('1,737', 0.989, [401, 416, 466, 438]),
      line('6', 0.988, [532, 417, 549, 436]),
    ]

    expect(parseRow(lines, column, rowOne).username).toBe('TyggrGMR')
  })
})
