/**
 * Bundle substitutions for the on-device OCR, shared by both Vite configs (the
 * Cloudflare/Worker build and the Vercel browser build) so they cannot drift.
 *
 * `onnxruntime-web` resolves by default to its WebGPU/JSEP build, whose WASM
 * binary is 28 MB. The scan only needs the plain WASM execution provider, whose
 * binary is 14.8 MB, so the package is pinned to its `wasm` entry point here and
 * `reader.ts` sets `backend: 'wasm'` to match.
 *
 * OpenCV was tried here too and cannot be stubbed: `predict()` reaches for
 * `cv.Mat` on every call, so `@techstark/opencv-js` (9.9 MB) stays in the
 * bundle. The gate in `ocr-lab` is what caught that, and it is what verifies
 * this alias: if the WASM build changes a single read, the gate fails.
 */
export const ocrAliases = [
  {
    find: /^onnxruntime-web$/,
    replacement: 'onnxruntime-web/wasm',
  },
]
