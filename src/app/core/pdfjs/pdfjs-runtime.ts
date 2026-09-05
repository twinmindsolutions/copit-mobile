import { Capacitor } from '@capacitor/core';

export type PromiseTryCompatible = PromiseConstructor & {
  try?: <T>(
    callback: (...args: unknown[]) => T | PromiseLike<T>,
    ...args: unknown[]
  ) => Promise<Awaited<T>>;
};

export type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
export type PdfJsImporter = () => Promise<PdfJsModule>;
export type PdfJsFakeWorkerImporter = () => Promise<typeof import('pdfjs-dist/legacy/build/pdf.worker.min.mjs')>;

export const PDFJS_WORKER_ASSET_PATH = 'assets/pdfjs/pdf.worker.bootstrap.mjs';

let cachedPdfJsModulePromise: Promise<PdfJsModule> | null = null;
let cachedPdfJsFakeWorkerPromise: Promise<unknown> | null = null;

export function installPromiseTryCompat(target: PromiseTryCompatible = Promise): void {
  if (typeof target.try === 'function') {
    return;
  }

  Object.defineProperty(target, 'try', {
    configurable: true,
    writable: true,
    value: function promiseTry<T>(
      callback: (...args: unknown[]) => T | PromiseLike<T>,
      ...args: unknown[]
    ): Promise<Awaited<T>> {
      return new target((resolve, reject) => {
        try {
          resolve(callback(...args) as Awaited<T>);
        } catch (error) {
          reject(error);
        }
      });
    },
  });
}

export async function loadPdfJsModule(
  importer: PdfJsImporter = () => import('pdfjs-dist/legacy/build/pdf.mjs')
): Promise<PdfJsModule> {
  installPromiseTryCompat();

  cachedPdfJsModulePromise ??= importer();
  return cachedPdfJsModulePromise;
}

export function shouldUsePdfJsFakeWorker(): boolean {
  return isNativeIosCapacitor();
}

export function isNativeIosCapacitor(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}

export async function loadPdfJsFakeWorkerModule(
  importer: PdfJsFakeWorkerImporter = () => import('pdfjs-dist/legacy/build/pdf.worker.min.mjs')
): Promise<void> {
  // PDF.js detects this module's WorkerMessageHandler and uses its supported
  // main-thread fake-worker path instead of creating a Web Worker.
  cachedPdfJsFakeWorkerPromise ??= importer();
  await cachedPdfJsFakeWorkerPromise;
}

export function resetPdfJsModuleForTests(): void {
  cachedPdfJsModulePromise = null;
  cachedPdfJsFakeWorkerPromise = null;
}
