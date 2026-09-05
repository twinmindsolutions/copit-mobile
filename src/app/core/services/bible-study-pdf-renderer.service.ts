import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';
import { Capacitor, CapacitorHttp } from '@capacitor/core';

import { environment } from '../../../environments/environment';
import {
  loadPdfJsModule,
  loadPdfJsFakeWorkerModule,
  PDFJS_WORKER_ASSET_PATH,
  isNativeIosCapacitor,
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
type PdfLoadMode = 'native-binary' | 'direct-url';
type PdfLoadStage = 'pdfjs-runtime' | 'worker-setup' | 'native-download' | 'pdfjs-load' | 'document-ready';
type PdfWorkerMode = 'normal-worker' | 'fake-worker';
type PdfExceptionDetails = {
  exception_name: string;
  exception_message: string;
};
@Injectable({ providedIn: 'root' })
export class BibleStudyPdfRendererService {
  private static workerConfigured = false;
  private static resolvedWorkerSrc = '';

  private documentTask?: PdfDocumentLoadingTask;
  private documentProxy?: PdfDocumentProxy;
  private renderTasks = new Map<number, PdfRenderTask>();
  private sessionId = 0;
  private activeLoadContext?: {
    platform: string;
    pdf_host: string;
    transport_mode: PdfLoadMode;
    worker_mode: PdfWorkerMode;
  };

  constructor(
    @Inject(DOCUMENT) private readonly document: Document,
    private readonly sentryTelemetry: SentryTelemetryService
  ) {}

  async loadDocument(url: string): Promise<BibleStudyPdfDocumentLoadResult> {
    await this.destroy();
    const useNativeBinary = isNativeIosCapacitor();
    const loadMode: PdfLoadMode = useNativeBinary ? 'native-binary' : 'direct-url';
    const diagnostics = {
      platform: Capacitor.getPlatform(),
      pdf_host: this.getSanitizedHost(url),
      transport_mode: loadMode,
      native_http_status: null as number | null,
      response_byte_length: null as number | null,
      pdf_stage: 'pdfjs-runtime' as PdfLoadStage,
      worker_mode: useNativeBinary ? 'fake-worker' as PdfWorkerMode : 'normal-worker' as PdfWorkerMode,
    };

    try {
      const pdfjsLib = await loadPdfJsModule();
      diagnostics.pdf_stage = 'worker-setup';
      const workerMode = await this.configureWorker(pdfjsLib);
      diagnostics.worker_mode = workerMode;
      this.activeLoadContext = {
        platform: diagnostics.platform,
        pdf_host: diagnostics.pdf_host,
        transport_mode: diagnostics.transport_mode,
        worker_mode: workerMode,
      };
      const activeSessionId = ++this.sessionId;
      const startedAt = performance.now();
      diagnostics.pdf_stage = useNativeBinary ? 'native-download' : 'pdfjs-load';
      const fetchStartedAt = performance.now();
      this.addLifecycleBreadcrumb('pdf_fetch_started', {
        ...diagnostics,
      });

      if (useNativeBinary) {
        const response = await CapacitorHttp.get({
          url,
          responseType: 'arraybuffer',
        });
        diagnostics.native_http_status = response.status;
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Native PDF download failed with status ${response.status}.`);
        }

        const data = this.decodeNativePdfResponse(response.data);
        diagnostics.response_byte_length = data.byteLength;
        this.addLifecycleBreadcrumb('pdf_fetch_succeeded', {
          ...diagnostics,
          elapsed_ms: Math.round(performance.now() - fetchStartedAt),
        });
        diagnostics.pdf_stage = 'pdfjs-load';
        this.addLifecycleBreadcrumb('pdfjs_load_started', diagnostics);
        this.documentTask = pdfjsLib.getDocument({
          data,
          useSystemFonts: true,
        });
      } else {
        this.addLifecycleBreadcrumb('pdfjs_load_started', diagnostics);
        this.documentTask = pdfjsLib.getDocument({
          url,
          withCredentials: false,
          useSystemFonts: true,
        });
      }

      const documentProxy = await this.documentTask.promise;

      if (activeSessionId !== this.sessionId) {
        await this.documentTask?.destroy();
        throw new Error('PDF reader session changed while loading.');
      }

      this.documentProxy = documentProxy;
      if (!useNativeBinary) {
        this.addLifecycleBreadcrumb('pdf_fetch_succeeded', {
          ...diagnostics,
          elapsed_ms: Math.round(performance.now() - fetchStartedAt),
        });
      }
      diagnostics.pdf_stage = 'document-ready';
      this.addLifecycleBreadcrumb('pdfjs_load_succeeded', {
        ...diagnostics,
        total_pages: documentProxy.numPages,
        elapsed_ms: Math.round(performance.now() - startedAt),
      });

      return {
        totalPages: documentProxy.numPages,
      };
    } catch (error) {
      const errorDetails = this.describeError(error);
      const failureEvent = diagnostics.pdf_stage === 'native-download' || this.isFetchFailure(error)
        ? 'pdf_fetch_failed'
        : 'pdfjs_load_failed';
      this.log(failureEvent, { ...diagnostics, failure_stage: diagnostics.pdf_stage, ...errorDetails });
      this.reportFailure(failureEvent, error, errorDetails, {
        ...diagnostics,
        failure_stage: diagnostics.pdf_stage,
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

    this.addLifecycleBreadcrumb('pdf_page_render_started', {
      ...this.getActiveLoadDiagnostics(),
      pdf_stage: 'render',
      page_number: pageNumber,
    });
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
      const errorDetails = this.describeError(error);
      this.log('pdf_page_render_failed', {
        pageNumber,
        ...this.getActiveLoadDiagnostics(),
        pdf_stage: 'render',
        ...errorDetails,
      });
      this.reportFailure('pdf_page_render_failed', error, errorDetails, {
        ...this.getActiveLoadDiagnostics(),
        pdf_stage: 'render',
        page_number: pageNumber,
      });
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

  private async configureWorker(pdfjsLib: PdfJsModule): Promise<PdfWorkerMode> {
    if (shouldUsePdfJsFakeWorker()) {
      await loadPdfJsFakeWorkerModule();
      return 'fake-worker';
    }

    if (BibleStudyPdfRendererService.workerConfigured) {
      return 'normal-worker';
    }

    BibleStudyPdfRendererService.resolvedWorkerSrc = new URL(PDFJS_WORKER_ASSET_PATH, this.document.baseURI).toString();
    pdfjsLib.GlobalWorkerOptions.workerSrc = BibleStudyPdfRendererService.resolvedWorkerSrc;
    BibleStudyPdfRendererService.workerConfigured = true;
    return 'normal-worker';
  }

  private clampScale(value: number): number {
    return Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, value));
  }

  private log(message: string, details: Record<string, unknown>): void {
    if (!environment.production) {
      console.info('[BibleStudyPdfRendererService]', message, details);
    }
  }

  private addLifecycleBreadcrumb(event: string, details: Record<string, unknown>): void {
    this.sentryTelemetry.addFeatureBreadcrumb('bible_study', event, details);
    this.log(event, details);
  }

  private reportFailure(
    message: string,
    originalError: unknown,
    error: PdfExceptionDetails,
    details: Record<string, unknown>
  ): void {
    this.sentryTelemetry.captureFeatureError('bible_study', message, this.createSanitizedError(originalError, error), {
      ...details,
      ...error,
    });
  }

  private getSanitizedHost(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return 'invalid-url';
    }
  }

  private getActiveLoadDiagnostics(): Record<string, unknown> {
    return this.activeLoadContext ?? {
      platform: Capacitor.getPlatform(),
      pdf_host: 'unknown',
      transport_mode: 'unknown',
      worker_mode: 'unknown',
    };
  }

  private decodeNativePdfResponse(data: unknown): Uint8Array {
    if (typeof data !== 'string') {
      throw new Error('Native PDF response did not contain binary data.');
    }

    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (!bytes.byteLength) {
      throw new Error('Native PDF response was empty.');
    }
    return bytes;
  }

  private describeError(error: unknown): PdfExceptionDetails {
    const errorRecord = error as { name?: string; message?: string; stack?: string } | undefined;
    return {
      exception_name: String(errorRecord?.name ?? 'UnknownError'),
      exception_message: this.sanitizeErrorMessage(String(errorRecord?.message ?? 'Unknown error')),
    };
  }

  private createSanitizedError(originalError: unknown, details: PdfExceptionDetails): Error {
    const sanitizedError = new Error(details.exception_message);
    sanitizedError.name = details.exception_name;
    const stack = (originalError as { stack?: unknown } | undefined)?.stack;
    if (typeof stack === 'string') {
      sanitizedError.stack = this.sanitizeErrorMessage(stack);
    }
    return sanitizedError;
  }

  private sanitizeErrorMessage(message: string): string {
    return message.replace(/https?:\/\/[^\s'"`]+/gi, (url) => {
      try {
        return `[${new URL(url).hostname}]`;
      } catch {
        return '[URL]';
      }
    });
  }

  private isFetchFailure(error: unknown): boolean {
    const message = String((error as { message?: string } | undefined)?.message ?? '').toLowerCase();
    return message.includes('load failed') || message.includes('network') || message.includes('fetch') || message.includes('cors');
  }
}
