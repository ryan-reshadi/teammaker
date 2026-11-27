/**
 * The in-browser screenshot scan.
 *
 * This is the client's whole OCR entry point: decode the upload, run the ported
 * pipeline with the browser reader, and hand back the same `RivalsScan` document
 * the server used to return. Nothing leaves the device.
 */

import type { RivalsScan } from '../../shared/rivals'
import { decodeScreenshot } from './image'
import { analyzeImage, type TextReader } from './pipeline'
import { BrowserTextReader, type ReaderOptions } from './reader'

export type { ScanDocument } from './pipeline'

export type ScanOptions = ReaderOptions & {
  /**
   * Stops the scan between OCR passes.
   *
   * Inference cannot be interrupted: it runs on this thread and blocks it until
   * it returns. So the signal is checked before each read and again after it,
   * which is where a scan spends its time waiting anyway — a twelve-row board
   * is a dozen separate passes.
   */
  signal?: AbortSignal
}

/** The abort shape the import panel recognises. */
export function cancelError(): Error {
  const error = new Error('The scan was cancelled.')
  error.name = 'AbortError'
  return error
}

function checkAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw cancelError()
}

export async function scanScreenshot(
  file: File | Blob,
  onProgress?: (message: string) => void,
  options: ScanOptions = {},
): Promise<RivalsScan> {
  const { signal, ...readerOptions } = options
  checkAborted(signal)
  const image = await decodeScreenshot(file)
  checkAborted(signal)
  onProgress?.('Preparing the screenshot…')

  const reader = new BrowserTextReader({ ...readerOptions, onProgress })
  // Every stage asks this reader for lines, so guarding the seam is what makes a
  // cancel land between passes instead of after the whole scan.
  const guarded: TextReader = {
    name: reader.name,
    async read(bitmap, region) {
      checkAborted(signal)
      const lines = await reader.read(bitmap, region)
      checkAborted(signal)
      return lines
    },
  }

  const document = await analyzeImage(image, guarded)
  checkAborted(signal)
  return document as unknown as RivalsScan
}
