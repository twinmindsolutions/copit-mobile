import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  QueryList,
  ViewChild,
  ViewChildren,
  inject,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { IonicModule, IonContent } from '@ionic/angular';
import { Subscription } from 'rxjs';

import { LocaleService } from '../../core/localization/locale.service';
import { TranslatePipe } from '../../core/localization/translate.pipe';
import { BibleStudyManualDetail } from '../../core/models/bible-study.model';
import { AppToastService } from '../../core/services/app-toast.service';
import { BibleStudyPdfRendererService } from '../../core/services/bible-study-pdf-renderer.service';
import { BibleStudyService } from '../../core/services/bible-study.service';
import { ExternalBrowserService } from '../../core/services/external-browser.service';
import { StackNavigationService } from '../../core/services/stack-navigation.service';
import { SentryTelemetryService } from '../../core/services/sentry-telemetry.service';

type ReaderViewState = 'loading' | 'ready' | 'error';
type ReaderLoadingStage = 'manual' | 'document' | 'render';
type ReaderErrorKind =
  | 'none'
  | 'invalid-id'
  | 'manual-not-found'
  | 'manual-load'
  | 'pdf-missing'
  | 'invalid-document'
  | 'render'
  | 'worker'
  | 'network'
  | 'cors'
  | 'pdf-unavailable';

interface ReaderPageState {
  pageNumber: number;
  status: 'pending' | 'rendering' | 'ready' | 'error';
  width: number;
  height: number;
  renderedZoom: number | null;
  hasRendered: boolean;
}

@Component({
  standalone: true,
  selector: 'app-bible-study-reader',
  imports: [CommonModule, IonicModule, TranslatePipe],
  templateUrl: './bible-study-reader.page.html',
  styleUrls: ['./bible-study-reader.page.scss'],
})
export class BibleStudyReaderPage implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly bibleStudyService = inject(BibleStudyService);
  private readonly bibleStudyPdfRendererService = inject(BibleStudyPdfRendererService);
  private readonly externalBrowserService = inject(ExternalBrowserService);
  private readonly stackNavigation = inject(StackNavigationService);
  private readonly appToast = inject(AppToastService);
  private readonly localeService = inject(LocaleService);
  private readonly sentryTelemetry = inject(SentryTelemetryService);

  @ViewChild(IonContent) private readonly ionContent?: IonContent;
  @ViewChildren('pageCanvas') private readonly pageCanvasRefs?: QueryList<ElementRef<HTMLCanvasElement>>;
  @ViewChildren('pageFrame') private readonly pageFrameRefs?: QueryList<ElementRef<HTMLElement>>;

  private manualRequestSubscription?: Subscription;
  private canvasRefsSubscription?: Subscription;
  private isViewActive = false;
  private loadRequestId = 0;
  private renderPassScheduled = false;
  private renderPassInFlight = false;
  private renderGeneration = 0;
  private firstPageRendered = false;
  private lastKnownScrollTop = 0;

  manual: BibleStudyManualDetail | null = null;
  pdfSourceUrl: string | null = null;
  sharingPdf = false;
  errorMessage = '';
  viewerState: ReaderViewState = 'loading';
  loadingStage: ReaderLoadingStage = 'manual';
  errorKind: ReaderErrorKind = 'none';
  totalPages = 0;
  currentPageNumber = 1;
  zoomLevel = 1;
  pages: ReaderPageState[] = [];

  ngAfterViewInit(): void {
    this.canvasRefsSubscription = this.pageCanvasRefs?.changes.subscribe(() => {
      this.queueRenderPass();
      this.updateCurrentPageFromScroll(this.lastKnownScrollTop);
    });
  }

  ionViewWillEnter(): void {
    this.isViewActive = true;
    this.loadManual();
  }

  ionViewWillLeave(): void {
    this.teardownActiveSession();
  }

  ionViewDidLeave(): void {
    this.teardownActiveSession();
  }

  ngOnDestroy(): void {
    this.canvasRefsSubscription?.unsubscribe();
    this.canvasRefsSubscription = undefined;
    this.teardownActiveSession();
  }

  loadManual(): void {
    const rawId = Number(this.route.snapshot.paramMap.get('id'));
    if (!Number.isInteger(rawId) || rawId <= 0) {
      this.manual = null;
      this.errorMessage = this.localeService.translate('bibleStudy.invalidId');
      this.resetPdfSurface();
      this.setErrorState('invalid-id');
      return;
    }

    this.cancelManualRequest();
    this.resetPdfSurface();
    this.viewerState = 'loading';
    this.loadingStage = 'manual';
    this.errorKind = 'none';
    this.errorMessage = '';
    this.manual = null;
    this.totalPages = 0;
    this.currentPageNumber = 1;
    this.zoomLevel = 1;

    const requestId = ++this.loadRequestId;
    this.manualRequestSubscription = this.bibleStudyService.getPublishedManualDetail(rawId).subscribe({
      next: (manual) => {
        if (!this.isViewActive || requestId !== this.loadRequestId) {
          return;
        }

        const pdfSourceUrl = this.normalizePdfSourceUrl(manual.pdf_url);
        this.manual = manual;
        this.pdfSourceUrl = pdfSourceUrl;

        if (!pdfSourceUrl) {
          this.setErrorState('pdf-missing', this.localeService.translate('bibleStudy.pdfMissingMessage'));
          return;
        }

        this.loadingStage = 'document';
        this.errorKind = 'none';
        this.errorMessage = '';
        this.sentryTelemetry.addFeatureBreadcrumb('bible_study', 'pdf_reader_open_requested', {
          platform: Capacitor.getPlatform(),
          route: 'bible-study/:id/read',
          study_id: rawId,
          pdf_host: this.getSanitizedPdfHost(pdfSourceUrl),
          transport_mode: this.getPdfTransportMode(),
        });
        void this.loadPdfDocument(pdfSourceUrl, requestId);
      },
      error: (error: unknown) => {
        if (!this.isViewActive || requestId !== this.loadRequestId) {
          return;
        }

        this.manual = null;

        if (error instanceof HttpErrorResponse && error.status === 404) {
          this.setErrorState('manual-not-found');
          return;
        }

        this.setErrorState('manual-load', this.resolveManualLoadErrorMessage(error));
      },
    });
  }

  retryLoad(): void {
    this.loadManual();
  }

  retryPdfLoad(): void {
    this.loadManual();
  }

  handleReaderScroll(event: CustomEvent<{ scrollTop: number }>): void {
    this.lastKnownScrollTop = event.detail.scrollTop;
    this.updateCurrentPageFromScroll(this.lastKnownScrollTop);
    this.queueRenderPass();
  }

  async goBackToManual(): Promise<void> {
    await this.stackNavigation.backWithFallback('/tabs/bible-study');
  }

  async goBackToList(): Promise<void> {
    await this.stackNavigation.backWithFallback('/tabs/bible-study');
  }

  async sharePdf(): Promise<void> {
    if (!this.pdfSourceUrl || this.sharingPdf) {
      return;
    }

    const shareTitle = this.manual?.title?.trim() || this.localeService.translate('bibleStudy.manualLabel');
    const shareUrl = this.pdfSourceUrl;
    this.sharingPdf = true;

    try {
      if (this.isNativePlatform()) {
        const canShare = await Share.canShare();
        if (!canShare.value) {
          throw new Error('native-share-unavailable');
        }

        await Share.share({
          title: shareTitle,
          url: shareUrl,
          dialogTitle: this.localeService.translate('bibleStudy.shareDialogTitle'),
        });
        return;
      }

      const navigatorShare = this.getNavigatorShare();
      if (navigatorShare) {
        await navigatorShare({ title: shareTitle, url: shareUrl });
        return;
      }

      const copied = await this.copyShareUrlToClipboard(shareUrl);
      if (copied) {
        await this.appToast.success(this.localeService.translate('bibleStudy.shareCopied'));
        return;
      }

      await this.appToast.error(this.localeService.translate('bibleStudy.shareUnavailable'));
    } catch (error) {
      if (this.isShareCancelError(error)) {
        return;
      }

      const copied = await this.copyShareUrlToClipboard(shareUrl);
      if (copied) {
        await this.appToast.success(this.localeService.translate('bibleStudy.shareCopied'));
        return;
      }

      await this.appToast.error(this.localeService.translate('bibleStudy.shareFailed'));
    } finally {
      this.sharingPdf = false;
    }
  }

  async openPdfExternally(): Promise<void> {
    if (!this.pdfSourceUrl) {
      return;
    }

    const diagnostics = {
      platform: Capacitor.getPlatform(),
      pdf_host: this.getSanitizedPdfHost(this.pdfSourceUrl),
      transport_mode: 'external',
      pdf_stage: 'external-open',
    };

    try {
      this.sentryTelemetry.addFeatureBreadcrumb('bible_study', 'pdf_reader_external_open_requested', diagnostics);
      await this.externalBrowserService.openUrl(this.pdfSourceUrl);
    } catch (error) {
      const errorDetails = this.describePdfError(error);
      this.sentryTelemetry.captureFeatureError(
        'bible_study',
        'pdf_reader_external_open_failed',
        this.createSanitizedError(error, errorDetails),
        {
          ...diagnostics,
          ...errorDetails,
        }
      );
      await this.appToast.error(this.localeService.translate('bibleStudy.externalOpenError'));
    }
  }

  get readerBackFallbackRoute(): string {
    return '/tabs/bible-study';
  }

  get isLoading(): boolean {
    return this.viewerState === 'loading';
  }

  get isReaderReady(): boolean {
    return this.viewerState === 'ready';
  }

  get isErrorState(): boolean {
    return this.viewerState === 'error';
  }

  get isNotFoundState(): boolean {
    return this.errorKind === 'manual-not-found';
  }

  get isGenericErrorState(): boolean {
    return this.isErrorState && (this.errorKind === 'manual-load' || this.errorKind === 'invalid-id');
  }

  get isPdfMissingState(): boolean {
    return this.isErrorState && this.errorKind === 'pdf-missing';
  }

  get isPdfUnavailableState(): boolean {
    return this.isErrorState && ['pdf-unavailable', 'invalid-document', 'render', 'worker', 'network', 'cors'].includes(this.errorKind);
  }

  get shareDisabled(): boolean {
    return this.sharingPdf || !this.pdfSourceUrl;
  }

  get showPdfSurface(): boolean {
    return !!this.manual && this.totalPages > 0 && !this.isPdfMissingState && !this.isErrorState;
  }

  get showReaderLoadingShell(): boolean {
    return this.showPdfSurface && this.isLoading && !this.firstPageRendered;
  }

  get readerLoadingTitle(): string {
    return this.localeService.translate('bibleStudy.loadingTitle');
  }

  get readerLoadingMessage(): string {
    switch (this.loadingStage) {
      case 'document':
        return this.localeService.translate('bibleStudy.loadingDocumentMessage');
      case 'render':
        return this.localeService.translate('bibleStudy.renderingPageMessage', {
          current: this.loadingRenderPageNumber,
          total: this.totalPages || 1,
        });
      default:
        return this.localeService.translate('bibleStudy.requestingSignedLink');
    }
  }

  get openExternallyDisabled(): boolean {
    return !this.pdfSourceUrl;
  }

  get shareActionAriaLabel(): string {
    return this.sharingPdf
      ? this.localeService.translate('bibleStudy.sharingPdf')
      : this.localeService.translate('bibleStudy.sharePdf');
  }

  get showDocumentControls(): boolean {
    return this.showPdfSurface;
  }

  get canZoomOut(): boolean {
    return this.showDocumentControls && this.zoomLevel > 0.71;
  }

  get canZoomIn(): boolean {
    return this.showDocumentControls && this.zoomLevel < 1.79;
  }

  private cancelManualRequest(): void {
    this.manualRequestSubscription?.unsubscribe();
    this.manualRequestSubscription = undefined;
  }

  private resetPdfSurface(): void {
    this.renderGeneration += 1;
    this.renderPassScheduled = false;
    this.renderPassInFlight = false;
    this.firstPageRendered = false;
    this.lastKnownScrollTop = 0;
    this.pdfSourceUrl = null;
    this.sharingPdf = false;
    this.pages = [];
    this.totalPages = 0;
    this.currentPageNumber = 1;
    void this.bibleStudyPdfRendererService.destroy();
  }

  private teardownActiveSession(): void {
    this.isViewActive = false;
    this.cancelManualRequest();
    this.resetPdfSurface();
    this.viewerState = 'error';
    this.errorKind = 'none';
    this.errorMessage = '';
    this.manual = null;
  }

  private normalizePdfSourceUrl(value: string | null): string | null {
    return this.bibleStudyService.normalizeDocumentUrl(value);
  }

  private setErrorState(kind: ReaderErrorKind, message = ''): void {
    this.bibleStudyPdfRendererService.cancelAllRenders();
    this.viewerState = 'error';
    this.errorKind = kind;
    this.errorMessage = message;
  }

  private async loadPdfDocument(pdfSourceUrl: string, requestId: number): Promise<void> {
    try {
      const { totalPages } = await this.bibleStudyPdfRendererService.loadDocument(pdfSourceUrl);
      if (!this.isViewActive || requestId !== this.loadRequestId) {
        return;
      }

      this.totalPages = totalPages;
      this.pages = Array.from({ length: totalPages }, (_, index) => ({
        pageNumber: index + 1,
        status: 'pending',
        width: 0,
        height: 0,
        renderedZoom: null,
        hasRendered: false,
      }));
      this.loadingStage = 'render';
      this.loadingRenderPageNumber = 1;
      this.viewerState = 'loading';
      this.errorKind = 'none';
      this.errorMessage = '';
      this.firstPageRendered = false;
      this.changeDetectorRef.detectChanges();
      this.queueRenderPass();
    } catch (error) {
      if (!this.isViewActive || requestId !== this.loadRequestId) {
        return;
      }

      const kind = this.resolvePdfLoadErrorKind(error);
      this.setErrorState(kind, this.resolvePdfLoadErrorMessage(error));
    }
  }

  zoomOut(): void {
    this.applyZoom(this.zoomLevel - 0.15);
  }

  zoomIn(): void {
    this.applyZoom(this.zoomLevel + 0.15);
  }

  resetZoom(): void {
    this.applyZoom(1);
  }

  retryPage(pageNumber: number): void {
    const page = this.pages.find((item) => item.pageNumber === pageNumber);
    if (!page) {
      return;
    }

    page.status = 'pending';
    this.queueRenderPass();
  }

  trackPage(_index: number, page: ReaderPageState): number {
    return page.pageNumber;
  }

  private applyZoom(nextZoomLevel: number): void {
    const normalizedZoomLevel = Math.min(1.75, Math.max(0.7, Number(nextZoomLevel.toFixed(2))));
    if (Math.abs(normalizedZoomLevel - this.zoomLevel) < 0.001) {
      return;
    }

    this.zoomLevel = normalizedZoomLevel;
    this.renderGeneration += 1;
    this.bibleStudyPdfRendererService.cancelAllRenders();
    this.pages = this.pages.map((page) => ({
      ...page,
      status: 'pending',
    }));
    this.queueRenderPass();
  }

  private resolveManualLoadErrorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) {
        return this.localeService.translate('bibleStudy.offlineError');
      }

      if (error.status === 401 || error.status === 403) {
        return this.localeService.translate('bibleStudy.manualUnavailableShort');
      }
    }

    const message = String((error as { message?: string } | undefined)?.message ?? '').toLowerCase();
    if (message.includes('timeout')) {
      return this.localeService.translate('bibleStudy.manualTimeoutError');
    }

    return this.localeService.translate('bibleStudy.manualLoadFailure');
  }

  private get loadingRenderPageNumber(): number {
    return this.currentPageNumber || 1;
  }

  private set loadingRenderPageNumber(value: number) {
    this.currentPageNumber = Math.max(1, value);
  }

  private queueRenderPass(): void {
    if (!this.isViewActive || this.renderPassScheduled || !this.pages.length) {
      return;
    }

    this.renderPassScheduled = true;
    requestAnimationFrame(() => {
      this.renderPassScheduled = false;
      void this.runRenderPass();
    });
  }

  private async runRenderPass(): Promise<void> {
    if (!this.isViewActive || this.renderPassInFlight) {
      return;
    }

    const targetPage = this.findNextPageToRender();
    if (!targetPage) {
      return;
    }

    const canvas = this.getCanvasElement(targetPage.pageNumber);
    const frame = this.getPageFrameElement(targetPage.pageNumber);
    if (!canvas || !frame) {
      return;
    }

    const renderGeneration = this.renderGeneration;
    const containerWidth = frame.clientWidth;
    if (containerWidth <= 0) {
      return;
    }

    targetPage.status = 'rendering';
    this.loadingRenderPageNumber = targetPage.pageNumber;
    this.renderPassInFlight = true;

    try {
      const result = await this.bibleStudyPdfRendererService.renderPage(
        targetPage.pageNumber,
        canvas,
        containerWidth,
        this.zoomLevel
      );

      if (!this.isViewActive || renderGeneration !== this.renderGeneration) {
        return;
      }

      targetPage.status = 'ready';
      targetPage.width = result.width;
      targetPage.height = result.height;
      targetPage.renderedZoom = this.zoomLevel;
      targetPage.hasRendered = true;

      if (!this.firstPageRendered && targetPage.pageNumber === 1) {
        this.firstPageRendered = true;
        this.viewerState = 'ready';
      }

      if (!this.firstPageRendered) {
        this.viewerState = 'ready';
        this.firstPageRendered = true;
      }

      this.changeDetectorRef.detectChanges();
      this.updateCurrentPageFromScroll(this.lastKnownScrollTop);
    } catch (error) {
      if (this.bibleStudyPdfRendererService.isRenderCancellationError(error) || renderGeneration !== this.renderGeneration) {
        return;
      }

      targetPage.status = 'error';
      if (!this.firstPageRendered && targetPage.pageNumber === 1) {
        this.setErrorState('render', this.resolvePdfLoadErrorMessage(error));
      }
    } finally {
      this.renderPassInFlight = false;
      if (this.isViewActive) {
        this.queueRenderPass();
      }
    }
  }

  private findNextPageToRender(): ReaderPageState | undefined {
    const candidates = new Set<number>();
    const currentPage = this.currentPageNumber || 1;

    [1, 2, currentPage - 1, currentPage, currentPage + 1, currentPage + 2].forEach((pageNumber) => {
      if (pageNumber >= 1 && pageNumber <= this.totalPages) {
        candidates.add(pageNumber);
      }
    });

    const nextSequentialPending = this.pages.find((page) => page.status === 'pending');
    if (nextSequentialPending) {
      candidates.add(nextSequentialPending.pageNumber);
    }

    return Array.from(candidates)
      .sort((left, right) => left - right)
      .map((pageNumber) => this.pages.find((page) => page.pageNumber === pageNumber))
      .find((page): page is ReaderPageState => !!page && page.status === 'pending');
  }

  private getCanvasElement(pageNumber: number): HTMLCanvasElement | null {
    return (
      this.pageCanvasRefs?.find(
        (canvasRef) => Number(canvasRef.nativeElement.dataset['pageNumber']) === pageNumber
      )?.nativeElement ?? null
    );
  }

  private getPageFrameElement(pageNumber: number): HTMLElement | null {
    return (
      this.pageFrameRefs?.find(
        (frameRef) => Number(frameRef.nativeElement.dataset['pageNumber']) === pageNumber
      )?.nativeElement ?? null
    );
  }

  private updateCurrentPageFromScroll(scrollTop: number): void {
    if (!this.pageFrameRefs?.length) {
      return;
    }

    const viewportProbe = scrollTop + 120;
    let activePage = 1;

    for (const frameRef of this.pageFrameRefs.toArray()) {
      const pageNumber = Number(frameRef.nativeElement.dataset['pageNumber']) || 1;
      if (frameRef.nativeElement.offsetTop <= viewportProbe) {
        activePage = pageNumber;
      } else {
        break;
      }
    }

    this.currentPageNumber = activePage;
  }

  private resolvePdfLoadErrorKind(error: unknown): ReaderErrorKind {
    const name = String((error as { name?: string } | undefined)?.name ?? '').toLowerCase();
    const message = String((error as { message?: string } | undefined)?.message ?? '').toLowerCase();

    if (message.includes('worker')) {
      return 'worker';
    }

    if (message.includes('cors')) {
      return 'cors';
    }

    if (message.includes('network') || message.includes('failed to fetch')) {
      return 'network';
    }

    if (name.includes('invalidpdf') || message.includes('invalid pdf') || message.includes('corrupt')) {
      return 'invalid-document';
    }

    return 'pdf-unavailable';
  }

  private resolvePdfLoadErrorMessage(error: unknown): string {
    const name = String((error as { name?: string } | undefined)?.name ?? '').toLowerCase();
    const message = String((error as { message?: string } | undefined)?.message ?? '').toLowerCase();

    if (name.includes('missingpdf') || message.includes('missingpdf')) {
      return this.localeService.translate('bibleStudy.pdfMissingMessage');
    }

    if (name.includes('invalidpdf') || message.includes('invalid pdf') || message.includes('corrupt')) {
      return this.localeService.translate('bibleStudy.invalidPdfReaderError');
    }

    if (message.includes('worker')) {
      return this.localeService.translate('bibleStudy.readerWorkerError');
    }

    if (message.includes('cors') || message.includes('network') || message.includes('failed to fetch')) {
      return this.localeService.translate('bibleStudy.readerLoadError');
    }

    return this.localeService.translate('bibleStudy.readerUnavailableMessage');
  }

  private isNativePlatform(): boolean {
    return Capacitor.isNativePlatform();
  }

  private getPdfTransportMode(): 'direct-url' | 'native-binary' {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios' ? 'native-binary' : 'direct-url';
  }

  private getSanitizedPdfHost(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return 'invalid-url';
    }
  }

  private describePdfError(error: unknown): { exception_name: string; exception_message: string } {
    const errorRecord = error as { name?: string; message?: string } | undefined;
    return {
      exception_name: String(errorRecord?.name ?? 'UnknownError'),
      exception_message: String(errorRecord?.message ?? 'Unknown error').replace(/https?:\/\/[^\s'"`]+/gi, '[URL]'),
    };
  }

  private createSanitizedError(
    originalError: unknown,
    details: { exception_name: string; exception_message: string }
  ): Error {
    const sanitizedError = new Error(details.exception_message);
    sanitizedError.name = details.exception_name;
    const stack = (originalError as { stack?: unknown } | undefined)?.stack;
    if (typeof stack === 'string') {
      sanitizedError.stack = stack.replace(/https?:\/\/[^\s'"`]+/gi, '[URL]');
    }
    return sanitizedError;
  }

  private getNavigatorShare():
    | ((data: { title?: string; text?: string; url?: string }) => Promise<void>)
    | null {
    const navigatorRef = globalThis.navigator as Navigator & {
      share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
    };

    return typeof navigatorRef.share === 'function' ? navigatorRef.share.bind(navigatorRef) : null;
  }

  private async copyShareUrlToClipboard(url: string): Promise<boolean> {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) {
      return false;
    }

    try {
      await clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }

  private isShareCancelError(error: unknown): boolean {
    if (!error) {
      return false;
    }

    const message = typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : '';

    return /cancel/i.test(message);
  }
}
