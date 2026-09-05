import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';

import { environment } from '../../../environments/environment';
import {
  loadPdfJsModule,
  loadPdfJsFakeWorkerModule,
  PDFJS_WORKER_ASSET_PATH,
  type PdfJsModule,
  shouldUsePdfJsFakeWorker,
} from '../pdfjs/pdfjs-runtime';
import { SentryTelemetryService } from './sentry-telemetry.service';

type PdfDocumentLoadingTask = import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentLoadingTask;
type PdfDocumentProxy = import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentProxy;
type PdfRenderTask = import('pdfjs-dist/legacy/build/pdf.mjs').RenderTask;

export interface BibleStudyPdfDocumentLoadResult {
  totalPages: number;
}

export interface BibleStudyPdfPageRenderResult {
  width: number;
  height: number;
  scale: number;
}

const DEFAULT_OUTPUT_SCALE = 2;
const MIN_RENDER_SCALE = 0.6;
const MAX_RENDER_SCALE = 2.4;
@Injectable({ providedIn: 'root' })
export class BibleStudyPdfRendererService {
  private static workerConfigured = false;
  private static resolvedWorkerSrc = '';

  private documentTask?: PdfDocumentLoadingTask;
  private documentProxy?: PdfDocumentProxy;
  private renderTasks = new Map<number, PdfRenderTask>();
  private sessionId = 0;

  constructor(
    @Inject(DOCUMENT) private readonly document: Document,
    private readonly sentryTelemetry: SentryTelemetryService
  ) {}

  async loadDocument(url: string): Promise<BibleStudyPdfDocumentLoadResult> {
    await this.destroy();
    try {
      const pdfjsLib = await loadPdfJsModule();
      const workerMode = await this.configureWorker(pdfjsLib);
      const activeSessionId = ++this.sessionId;
      const startedAt = performance.now();
      this.log('getDocument start', {
        pdfjsVersion: '6.2.108',
        workerMode,
        workerSrc: BibleStudyPdfRendererService.resolvedWorkerSrc,
        documentOrigin: this.getSanitizedOrigin(url),
        documentPath: this.getSanitizedPath(url),
      });
      this.documentTask = pdfjsLib.getDocument({
        url,
        withCredentials: false,
        useSystemFonts: true,
      });

      const documentProxy = await this.documentTask.promise;

      if (activeSessionId !== this.sessionId) {
        await this.documentTask?.destroy();
        throw new Error('PDF reader session changed while loading.');
      }

      this.documentProxy = documentProxy;
      this.log('document loaded', {
        totalPages: documentProxy.numPages,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        totalPages: documentProxy.numPages,
      };
    } catch (error) {
      this.log('loadingTask rejection', this.describeError(error));
      this.reportFailure('PDF document startup or loading failed.', error, {
        document_origin: this.getSanitizedOrigin(url),
        document_path: this.getSanitizedPath(url),
      });
      throw error;
    }
  }

  async renderPage(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    containerWidth: number,
    zoomLevel: number
  ): Promise<BibleStudyPdfPageRenderResult> {
    const sessionId = this.sessionId;
    const documentProxy = this.documentProxy;
    if (!documentProxy) {
      throw new Error('PDF document is not loaded.');
    }

    this.cancelPageRender(pageNumber);

    const page = await documentProxy.getPage(pageNumber);
    if (sessionId !== this.sessionId) {
      page.cleanup();
      throw new Error('PDF reader session changed while rendering.');
    }

    const viewport = page.getViewport({ scale: 1 });
    const fitWidth = containerWidth > 0 ? containerWidth / viewport.width : 1;
    const renderScale = this.clampScale(fitWidth * zoomLevel);
    const renderViewport = page.getViewport({ scale: renderScale });
    const outputScale = Math.min(window.devicePixelRatio || 1, DEFAULT_OUTPUT_SCALE);
    const canvasContext = canvas.getContext('2d');

    if (!canvasContext) {
      page.cleanup();
      throw new Error('Unable to create the PDF canvas context.');
    }

    canvas.width = Math.max(1, Math.floor(renderViewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(renderViewport.height * outputScale));
    canvas.style.width = `${renderViewport.width}px`;
    canvas.style.height = `${renderViewport.height}px`;

    const renderTask = page.render({
      canvas: null,
      canvasContext,
      viewport: renderViewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
    });

    this.renderTasks.set(pageNumber, renderTask);

    try {
      await renderTask.promise;
      if (sessionId !== this.sessionId) {
        throw new Error('PDF reader session changed while rendering.');
      }

      return {
        width: renderViewport.width,
        height: renderViewport.height,
        scale: renderScale,
      };
    } catch (error) {
      this.log('page render failed', {
        pageNumber,
        ...this.describeError(error),
      });
      this.reportFailure('PDF page rendering failed.', error, { page_number: pageNumber });
      throw error;
    } finally {
      this.renderTasks.delete(pageNumber);
      page.cleanup();
    }
  }

  cancelPageRender(pageNumber: number): void {
    const renderTask = this.renderTasks.get(pageNumber);
    if (!renderTask) {
      return;
    }

    try {
      renderTask.cancel();
    } catch {
      // ignore cancellation failures
    } finally {
      this.renderTasks.delete(pageNumber);
    }
  }

  cancelAllRenders(): void {
    Array.from(this.renderTasks.keys()).forEach((pageNumber) => this.cancelPageRender(pageNumber));
  }

  async destroy(): Promise<void> {
    this.cancelAllRenders();
    this.sessionId += 1;

    const documentTask = this.documentTask;
    const documentProxy = this.documentProxy;
    this.documentTask = undefined;
    this.documentProxy = undefined;

    try {
      await documentTask?.destroy();
    } catch {
      // ignore document task cleanup failures
    }

    try {
      await documentProxy?.cleanup();
    } catch {
      // ignore document cleanup failures
    }
  }

  isRenderCancellationError(error: unknown): boolean {
    const name = String((error as { name?: string } | undefined)?.name ?? '');
    const message = String((error as { message?: string } | undefined)?.message ?? '');
    return (
      name.includes('RenderingCancelledException') ||
      name.includes('AbortException') ||
      message.includes('cancelled') ||
      message.includes('canceled')
    );
  }

  private async configureWorker(pdfjsLib: PdfJsModule): Promise<'fake-worker' | 'web-worker'> {
    if (shouldUsePdfJsFakeWorker()) {
      await loadPdfJsFakeWorkerModule();
      return 'fake-worker';
    }

    if (BibleStudyPdfRendererService.workerConfigured) {
      return 'web-worker';
    }

    BibleStudyPdfRendererService.resolvedWorkerSrc = new URL(PDFJS_WORKER_ASSET_PATH, this.document.baseURI).toString();
    pdfjsLib.GlobalWorkerOptions.workerSrc = BibleStudyPdfRendererService.resolvedWorkerSrc;
    this.log('worker configured', {
      pdfjsVersion: '6.2.108',
      workerSrc: BibleStudyPdfRendererService.resolvedWorkerSrc,
      baseUri: this.document.baseURI,
    });
    BibleStudyPdfRendererService.workerConfigured = true;
    return 'web-worker';
  }

  private clampScale(value: number): number {
    return Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, value));
  }

  private log(message: string, details: Record<string, unknown>): void {
    if (!environment.production) {
      console.info('[BibleStudyPdfRendererService]', message, details);
    }
  }

  private reportFailure(message: string, error: unknown, details: Record<string, unknown>): void {
    this.sentryTelemetry.captureFeatureError('bible_study', message, error, details);
  }

  private getSanitizedOrigin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return 'invalid-url';
    }
  }

  private getSanitizedPath(url: string): string {
    try {
      return new URL(url).pathname;
    } catch {
      return 'invalid-url';
    }
  }

  private describeError(error: unknown): Record<string, string> {
    const errorRecord = error as { name?: string; message?: string; stack?: string } | undefined;
    return {
      name: String(errorRecord?.name ?? 'UnknownError'),
      message: String(errorRecord?.message ?? 'Unknown error'),
    };
  }
}
