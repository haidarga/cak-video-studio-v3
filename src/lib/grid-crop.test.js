import { describe, it, expect } from 'vitest'
import { gridLayout, cellRect } from './grid-crop.js'
import { gridDims } from './fal-client.js'

describe('gridLayout — stays in sync with fal-client gridDims', () => {
  it('matches gridDims for the clean counts', () => {
    for (const n of [4, 6, 9]) {
      const a = gridLayout(n)
      const b = gridDims(n)
      expect({ rows: a.rows, cols: a.cols }).toEqual({ rows: b.rows, cols: b.cols })
    }
  })
})

describe('cellRect — last cell lands on the right still', () => {
  it('2x2 grid, last cell (idx 3) = bottom-right quadrant', () => {
    expect(cellRect(4, 3, 1000, 1000)).toEqual({ x: 500, y: 500, w: 500, h: 500 })
  })
  it('2x3 grid (6 panels), last cell (idx 5) = bottom-right', () => {
    expect(cellRect(6, 5, 900, 1200)).toEqual({ x: 600, y: 600, w: 300, h: 600 })
  })
  it('3x3 grid (9 panels), last cell (idx 8) = bottom-right', () => {
    expect(cellRect(9, 8, 900, 900)).toEqual({ x: 600, y: 600, w: 300, h: 300 })
  })
  it('first cell is always top-left', () => {
    expect(cellRect(6, 0, 900, 1200)).toMatchObject({ x: 0, y: 0 })
  })
  it('clamps an out-of-range cellIndex to the last cell', () => {
    expect(cellRect(4, 99, 1000, 1000)).toEqual(cellRect(4, 3, 1000, 1000))
  })
})
