/**
 * The browser text reader: PaddleOCR's official JS SDK behind the same small
 * seam `ocr/rivals_ocr/recognize.py` exposes on the server.
 *
 * The pipeline only asks for lines, so the engine can be swapped (or stubbed in
 * tests) without touching any geometry.
 */

import { PaddleOCR } from '@paddleocr/paddleocr-js'

import { toImageData, type Bitmap, type Box } from './image'
import type { TextLine } from './layout'
import type { TextReader } from './pipeline'

/** `PaddleOCR.create` returns the in-process pipeline or a worker-backed one. */
type Engine = {
  predict: (input: unknown) => Promise<
    { items?: { text?: string; score?: number; poly?: unknown }[] }[] | null
  >
}

export type ReaderOptions = {
  /**
   * PP-OCRv5, not v6.
   *
   * In `@paddleocr/paddleocr-js` 0.4.2 the PP-OCRv6 weights load but recognise
   * nothing: detection finds boxes and every one decodes to an empty string, so
   * a bare `predict()` returns zero items. PP-OCRv5 on the same input reads the
   * scoreboard correctly, so the client runs on v5 until the SDK's v6 path is
   * fixed. The option is kept so the tier can be re-tested without a code edit.
   */
  ocrVersion?: 'PP-OCRv5' | 'PP-OCRv6'
  /**
   * Points recognition at a different weights tarball.
   *
   * The SDK only resolves *names* in its own six-model registry, so a swap needs
   * both: a name that matches the tarball's own `inference.yml` and the URL as an
   * asset. Two smaller candidates were measured on the `ocr-lab` gate and both
   * cost damage accuracy — `en_PP-OCRv5_mobile_rec` (7.5 MiB) dropped usernames
   * 14/16 → 13/16 and damage 18/18 → 17/18, and `latin_PP-OCRv5_mobile_rec`
   * (7.7 MiB) dropped damage to 15/18 — so the multilingual 15.9 MiB model is
   * what ships. A wrong damage figure moves elo; a smaller download is not worth
   * it. The option stays so a new candidate can be gated without a code change.
   */
  recognitionModel?: { name: string; url: string }
  lang?: string
  onProgress?: (message: string) => void
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))



function bbox(poly: number[][] | undefined): Box {
  if (!poly || !poly.length) return [0, 0, 0, 0]
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const point of poly) {
    const [x, y] = point
    if (typeof x !== 'number' || typeof y !== 'number') continue
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  if (!Number.isFinite(x0)) return [0, 0, 0, 0]
  return [x0, y0, x1, y1]
}

export class BrowserTextReader implements TextReader {
  readonly name = 'paddleocr-web'

  private engine: Engine | null = null
  private loading: Promise<Engine> | null = null

  constructor(private readonly options: ReaderOptions = {}) {}

  async load(): Promise<Engine> {
    if (this.engine) return this.engine
    if (this.loading) return this.loading
    this.options.onProgress?.('Loading the OCR engine…')
    const started = (
      PaddleOCR.create({
        lang: this.options.lang ?? 'en',
        ocrVersion: this.options.ocrVersion ?? 'PP-OCRv5',
        // The name selects the recogniser in the SDK's registry; the asset
        // supplies the weights, which is the only supported way to swap the
        // multilingual model for the English one.
        ...(this.options.recognitionModel
          ? {
              textRecognitionModelName: this.options.recognitionModel.name,
              textRecognitionModelAsset: { url: this.options.recognitionModel.url },
            }
          : {}),
        // WASM only. This is paired with the `onnxruntime-web/wasm` alias in
        // `vite.ocr-alias.ts`: the WebGPU/JSEP build ships a 28 MB WASM binary,
        // the plain one is 14 MB, and the scan does not need a GPU either way.
        ortOptions: { backend: 'wasm' },
      }) as unknown as Promise<Engine>
    ).then((engine) => {
      this.engine = engine
      return engine
    })
    this.loading = started
    try {
      return await started
    } finally {
      this.loading = null
    }
  }

  async read(image: Bitmap, region = 'row'): Promise<TextLine[]> {
    if (image.width === 0 || image.height === 0) return []
    const engine = await this.load()
    this.options.onProgress?.(region === 'table' ? 'Reading the scoreboard…' : 'Reading…')
    const results = await engine.predict(toImageData(image))
    const lines: TextLine[] = []
    for (const result of results ?? []) {
      for (const item of result.items ?? []) {
        const text = String(item.text ?? '')
        if (!text.trim()) continue
        lines.push({ text, confidence: clamp(Number(item.score ?? 0)), box: bbox(item.poly as number[][]) })
      }
    }
    return lines
  }
}
