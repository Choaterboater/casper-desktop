/**
 * Render the Chat running-status ghost: a 28×28 grayscale-alpha APNG of sixty 50 ms frames that loops forever.
 * The Chat stylesheet uses it as an alpha mask in the text colour; the upstream file name `running-whale@2x.png` is kept.
 * The ghost floats with a small lean while its skirt ripples twice per 3 s loop; frame 0 is the resting outline that
 * `RunningWhaleTail.tsx` draws as its still icon, which this script prints.
 *
 * Run `node --import tsx/esm apps/web/scripts/render-running-ghost.ts` from the repository root.
 * @module render-running-ghost
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import sharp from 'sharp'

const SIZE = 28
const FRAMES = 60
/** Frame delay as an APNG fraction of a second: 1/20 s is 50 ms, so the loop lasts 3 s. */
const DELAY = { numerator: 1, denominator: 20 }
const OUTPUT = resolve(import.meta.dirname, '../../../packages/client/ui-chat/src/client/assets/running-whale@2x.png')
/* Skirt steps right to left in the 16-unit box: at rest the points alternate up and down; the wave shifts them by one. */
const REST_STEPS = [-1, 1, -1, 1, -1, 1, -1, 1]
const WAVE_STEPS = [0, -1, 1, -1, 1, -1, 1, 0]
const EYES = 'M5.6 7.6a.7 .9 0 1 0 1.4 0a.7 .9 0 1 0-1.4 0zM9 7.6a.7 .9 0 1 0 1.4 0a.7 .9 0 1 0-1.4 0z'

const format = (value: number): string => String(Number(value.toFixed(3)))

/**
 * Build the ghost outline in a 16-unit box: the body, its zigzag skirt and two eyes.
 * @param wave - skirt position from 0 (rest) to 1 (points shifted by one step).
 * @returns SVG path data with the same commands at every `wave`.
 */
export function ghostOutline(wave: number): string {
  const steps = REST_STEPS.map((rest, index) => `-1.25 ${format(rest + (WAVE_STEPS[index]! - rest) * wave)}`)
  return `M3 8a5 5 0 0 1 10 0v6l${steps.join(' ')}z${EYES}`
}

function frameSvg(index: number): string {
  const turn = index / FRAMES
  const lift = format(-0.9 * Math.sin(2 * Math.PI * turn))
  const lean = format(-3 * Math.sin(2 * Math.PI * turn))
  const wave = (1 - Math.cos(4 * Math.PI * turn)) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(SIZE)}" height="${String(SIZE)}" viewBox="0 0 16 16">`
    + `<g transform="translate(0 ${lift}) rotate(${lean} 8 14)">`
    + `<path d="${ghostOutline(wave)}" fill="none" stroke="#fff" stroke-width="1" stroke-linejoin="round"/></g></svg>`
}

/** Rasterize one frame to PNG scanlines of white with the drawing's coverage as alpha (filter type 0 per row). */
async function frameScanlines(index: number): Promise<Buffer> {
  const { data, info } = await sharp(Buffer.from(frameSvg(index))).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.width !== SIZE || info.height !== SIZE || info.channels !== 4) throw new Error(`frame ${String(index)} rendered ${String(info.width)}×${String(info.height)}×${String(info.channels)}`)
  const rows = Buffer.alloc(SIZE * (1 + SIZE * 2))
  for (let y = 0; y < SIZE; y++) {
    const row = y * (1 + SIZE * 2)
    for (let x = 0; x < SIZE; x++) {
      rows[row + 1 + x * 2] = 255
      rows[row + 2 + x * 2] = data[(y * SIZE + x) * 4 + 3]!
    }
  }
  return rows
}

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'latin1')
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([header, data, checksum])
}

function frameControl(sequence: number): Buffer {
  const data = Buffer.alloc(26)
  data.writeUInt32BE(sequence, 0)
  data.writeUInt32BE(SIZE, 4)
  data.writeUInt32BE(SIZE, 8)
  data.writeUInt16BE(DELAY.numerator, 20)
  data.writeUInt16BE(DELAY.denominator, 22)
  // Offsets 12 and 16 (x, y), dispose op 24 and blend op 25 stay 0: every frame replaces the whole canvas.
  return chunk('fcTL', data)
}

async function main(): Promise<void> {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8 // bit depth
  header[9] = 4 // grayscale with alpha
  const animation = Buffer.alloc(8)
  animation.writeUInt32BE(FRAMES, 0) // plays: 0 = forever
  const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('acTL', animation)]
  let sequence = 0
  for (let index = 0; index < FRAMES; index++) {
    chunks.push(frameControl(sequence++))
    const compressed = deflateSync(await frameScanlines(index), { level: 9 })
    if (index === 0) {
      chunks.push(chunk('IDAT', compressed))
    } else {
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32BE(sequence++, 0)
      chunks.push(chunk('fdAT', Buffer.concat([prefix, compressed])))
    }
  }
  chunks.push(chunk('IEND', Buffer.alloc(0)))
  await writeFile(OUTPUT, Buffer.concat(chunks))
  console.log(`render-running-ghost: wrote ${OUTPUT}`)
  console.log(`render-running-ghost: still icon path ${ghostOutline(0)}`)
}

await main()
