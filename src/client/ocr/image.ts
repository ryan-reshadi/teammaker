/**
 * Upload validation and pixel plumbing for the in-browser OCR.
 *
 * This is the browser counterpart of `ocr/rivals_ocr/imaging.py`: the same
 * limits, the same magic-byte sniffing and the same error codes, so a file that
 * the server rejected is rejected here for the same stated reason.
 */

export type Box = [number, number, number, number]

/** RGBA pixels, row-major — what the canvas gives us and what cv2 would hold. */
export type Bitmap = { width: number; height: number; data: Uint8ClampedArray }

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
export const DEFAULT_MAX_DIMENSION = 4096
export const DEFAULT_MIN_DIMENSION = 320

export class ScanFailure extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code = 'invalid_image', status = 400) {
    super(message)
    this.name = 'ScanFailure'
    this.code = code
    this.status = status
  }
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false
  return magic.every((value, index) => bytes[index] === value)
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_MAGIC = [0xff, 0xd8, 0xff]

/** Magic bytes only: a renamed file must never reach the decoder. */
export function sniffType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PNG_MAGIC)) return 'image/png'
  if (startsWith(bytes, JPEG_MAGIC)) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'RIFF' &&
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP'
  )
    return 'image/webp'
  return null
}

export async function decodeScreenshot(
  file: Blob,
  maxBytes: number = DEFAULT_MAX_BYTES,
  maxDimension: number = DEFAULT_MAX_DIMENSION,
  minDimension: number = DEFAULT_MIN_DIMENSION,
): Promise<Bitmap> {
  if (!file.size) throw new ScanFailure('The upload is empty.')
  if (file.size > maxBytes)
    throw new ScanFailure(
      `Screenshots are up to ${Math.round(maxBytes / (1024 * 1024))} MB.`,
      'too_large',
      413,
    )

  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (sniffType(head) === null)
    throw new ScanFailure('Only PNG, JPEG or WebP screenshots are supported.', 'unsupported_type', 415)

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new ScanFailure('That image could not be decoded.')
  }

  const width = bitmap.width
  const height = bitmap.height
  if (Math.max(width, height) > maxDimension) {
    bitmap.close()
    throw new ScanFailure(
      `Screenshots are up to ${maxDimension} pixels on the longest side.`,
    )
  }
  if (Math.min(width, height) < minDimension) {
    bitmap.close()
    throw new ScanFailure(
      `Screenshots must be at least ${minDimension} pixels wide and tall.`,
    )
  }

  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    bitmap.close()
    throw new ScanFailure('This browser could not decode the screenshot.')
  }
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  const image = context.getImageData(0, 0, width, height)
  return { width, height, data: image.data }
}

export function cropBitmap(image: Bitmap, box: Box): Bitmap {
  const [rawX0, rawY0, rawX1, rawY1] = box
  const x0 = Math.max(0, Math.min(image.width, Math.round(rawX0)))
  const y0 = Math.max(0, Math.min(image.height, Math.round(rawY0)))
  const x1 = Math.max(x0, Math.min(image.width, Math.round(rawX1)))
  const y1 = Math.max(y0, Math.min(image.height, Math.round(rawY1)))
  const width = x1 - x0
  const height = y1 - y0
  if (width <= 0 || height <= 0) return { width: 0, height: 0, data: new Uint8ClampedArray(0) }

  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const from = ((y0 + y) * image.width + x0) * 4
    out.set(image.data.subarray(from, from + width * 4), y * width * 4)
  }
  return { width, height, data: out }
}

/** Bilinear upscale, standing in for `cv2.resize(..., INTER_CUBIC)`. */
export function upscaleBitmap(image: Bitmap, factor: number): Bitmap {
  if (factor <= 1 || image.width === 0 || image.height === 0) return image
  const width = Math.round(image.width * factor)
  const height = Math.round(image.height * factor)
  const out = new Uint8ClampedArray(width * height * 4)
  const { data, width: inWidth, height: inHeight } = image

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(inHeight - 1, Math.max(0, (y + 0.5) / factor - 0.5))
    const y0 = Math.floor(sourceY)
    const y1 = Math.min(inHeight - 1, y0 + 1)
    const wy = sourceY - y0
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(inWidth - 1, Math.max(0, (x + 0.5) / factor - 0.5))
      const x0 = Math.floor(sourceX)
      const x1 = Math.min(inWidth - 1, x0 + 1)
      const wx = sourceX - x0
      const target = (y * width + x) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        const top =
          data[(y0 * inWidth + x0) * 4 + channel]! * (1 - wx) +
          data[(y0 * inWidth + x1) * 4 + channel]! * wx
        const bottom =
          data[(y1 * inWidth + x0) * 4 + channel]! * (1 - wx) +
          data[(y1 * inWidth + x1) * 4 + channel]! * wx
        out[target + channel] = top * (1 - wy) + bottom * wy
      }
      out[target + 3] = 255
    }
  }
  return { width, height, data: out }
}

export function toImageData(image: Bitmap): ImageData {
  // The pixels are copied into a plain ArrayBuffer: `ImageData` will not accept
  // a SharedArrayBuffer-backed view, and the reader wants its own copy anyway.
  const pixels = new Uint8ClampedArray(image.data.length)
  pixels.set(image.data)
  return new ImageData(pixels, image.width, image.height)
}
