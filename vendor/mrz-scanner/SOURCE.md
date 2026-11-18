# MRZ Scanner source and license

Passport Desk uses the browser pipeline from ALSENET MRZ Scanner v2, pinned to
commit `17df6608a5b3d487b2d34c7d0300cbb7079ea7c0`:

https://github.com/alsenet-labs/mrz-scanner/tree/17df6608a5b3d487b2d34c7d0300cbb7079ea7c0

The scanner is licensed under AGPL-3.0-or-later. The complete license is in
`LICENSE` beside this file. The application source using the scanner is in the
public Passport Desk repository.

Build changes from upstream:

- The demo UI was replaced by a module Web Worker adapter accepting image bytes
  and returning the upstream `scanMrz` result through `postMessage`.
- `onnxruntime-web/wasm` is used instead of the generic runtime because this
  scanner requests only the WASM execution provider.
- The worker is built as ES2022 with Vite 8 and the external WASM runtime, while
  the upstream MRZ detection, OCR, correction, and parsing source is unchanged.
- Vite's DOM-only module-preload helper is reduced to a direct dynamic import so
  the generated bundle remains valid inside a Web Worker.

Runtime versions: MRZ Scanner v2.0.0, ONNX Runtime Web 1.24.3.
