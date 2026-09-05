import { ComponentFixture, TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, throwError, BehaviorSubject } from 'rxjs';
import { Capacitor } from '@capacitor/core';

import { LocaleService, TranslationParams } from '../../core/localization/locale.service';
import { BibleStudyManualDetail } from '../../core/models/bible-study.model';
import { AppToastService } from '../../core/services/app-toast.service';
import { BibleStudyPdfRendererService } from '../../core/services/bible-study-pdf-renderer.service';
import { BibleStudyService } from '../../core/services/bible-study.service';
import { ExternalBrowserService } from '../../core/services/external-browser.service';
import { StackNavigationService } from '../../core/services/stack-navigation.service';
import { SentryTelemetryService } from '../../core/services/sentry-telemetry.service';
import { BibleStudyReaderPage } from './bible-study-reader.page';

class MockLocaleService {
  private readonly localeSubject = new BehaviorSubject<'en'>('en');

  readonly locale$ = this.localeSubject.asObservable();

  private readonly messages: Record<string, string> = {
    'bibleStudy.loadingTitle': 'Preparing your Bible Study',
    'bibleStudy.requestingSignedLink': 'Requesting a fresh signed PDF link.',
    'bibleStudy.loadingDocumentMessage': 'Loading the Bible Study document.',
    'bibleStudy.renderingPageMessage': 'Rendering page {{current}} of {{total}}.',
    'bibleStudy.renderingSinglePageMessage': 'Rendering page {{current}} of {{total}}.',
    'bibleStudy.pageIndicatorCompact': 'Page {{current}} / {{total}}',
    'bibleStudy.backToList': 'Back to Bible Study',
    'bibleStudy.tryAgain': 'Try Again',
    'bibleStudy.sharePdf': 'Share PDF',
    'bibleStudy.sharingPdf': 'Sharing PDF',
    'bibleStudy.shareDialogTitle': 'Share Bible Study',
    'bibleStudy.shareCopied': 'Bible Study PDF link copied to clipboard.',
    'bibleStudy.shareUnavailable': "This PDF can't be shared right now.",
    'bibleStudy.shareFailed': "Sharing isn't available right now.",
    'bibleStudy.openPdfExternally': 'Open PDF externally',
    'bibleStudy.pdfMissingMessage': 'This manual does not currently have a readable PDF link.',
    'bibleStudy.readerUnavailableBody': 'The PDF reader failed to start.',
    'bibleStudy.readerUnavailableMessage': 'We could not open this PDF on your device right now.',
    'bibleStudy.manualLoadFailure': "We couldn't load this Bible Study manual right now.",
    'bibleStudy.invalidId': 'Invalid Bible Study manual ID.',
    'bibleStudy.invalidPdfReaderError': 'This Bible Study PDF appears to be invalid or corrupted.',
    'bibleStudy.readerWorkerError': 'The PDF reader failed to start. Please try again.',
    'bibleStudy.readerLoadError': 'We could not load this Bible Study PDF right now.',
    'bibleStudy.pageRenderError': 'Page {{page}} could not be rendered.',
    'bibleStudy.zoomOut': 'Zoom out',
    'bibleStudy.zoomIn': 'Zoom in',
    'bibleStudy.fitWidth': 'Fit',
    'bibleStudy.readerPageAria': 'Bible Study page {{current}} of {{total }}',
    'bibleStudy.externalOpenError': 'We could not open this PDF outside the app right now.',
    'bibleStudy.readerUnavailableTitle': 'PDF unavailable',
    'bibleStudy.manualLoadError': "We couldn't load this manual",
    'bibleStudy.pdfMissingTitle': 'PDF unavailable',
    'bibleStudy.manualNotFoundTitle': 'Manual not found',
    'bibleStudy.manualNotFoundMessage': 'This Bible Study manual is no longer available.',
  };

  translate(key: string, params?: TranslationParams): string {
    const template = this.messages[key] ?? key;
    if (!params) {
      return template;
    }

    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, token: string) => {
      const value = params[token];
      return value === null || value === undefined ? '' : String(value);
    });
  }
}

describe('BibleStudyReaderPage', () => {
  let fixture: ComponentFixture<BibleStudyReaderPage>;
  let page: BibleStudyReaderPage;
  let routeId = '14';
  let bibleStudyService: jasmine.SpyObj<BibleStudyService>;
  let pdfRendererService: jasmine.SpyObj<BibleStudyPdfRendererService>;
  let externalBrowserService: jasmine.SpyObj<ExternalBrowserService>;
  let stackNavigationService: jasmine.SpyObj<StackNavigationService>;
  let appToast: jasmine.SpyObj<AppToastService>;
  let sentryTelemetry: jasmine.SpyObj<SentryTelemetryService>;

  const manual: BibleStudyManualDetail = {
    id: 14,
    title: 'Bible Study Manual',
    year: 2026,
    language: 'en',
    language_display: 'English',
    volume: 'Volume 1',
    start_week: 1,
    end_week: 4,
    publication_status: 'published',
    published_at: '2026-07-24T09:00:00Z',
    cover_image_url: 'https://example.com/cover.jpg',
    pdf_url: 'https://example.com/manual.pdf?X-Amz-Signature=fresh',
  };

  function createComponent(): void {
    fixture = TestBed.createComponent(BibleStudyReaderPage);
    page = fixture.componentInstance;
    page.ionViewWillEnter();
    fixture.detectChanges();
  }

  function flushReader(): void {
    flushMicrotasks();
    fixture.detectChanges();
    flushMicrotasks();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    routeId = '14';

    bibleStudyService = jasmine.createSpyObj<BibleStudyService>('BibleStudyService', [
      'getPublishedManualDetail',
      'normalizeDocumentUrl',
    ]);
    bibleStudyService.normalizeDocumentUrl.and.callFake((value: string | null | undefined) => {
      const candidate = (value ?? '').trim();
      return candidate ? candidate : null;
    });

    pdfRendererService = jasmine.createSpyObj<BibleStudyPdfRendererService>('BibleStudyPdfRendererService', [
      'loadDocument',
      'renderPage',
      'destroy',
      'cancelAllRenders',
      'isRenderCancellationError',
    ]);
    externalBrowserService = jasmine.createSpyObj<ExternalBrowserService>('ExternalBrowserService', ['openUrl']);
    stackNavigationService = jasmine.createSpyObj<StackNavigationService>('StackNavigationService', ['backWithFallback']);
    appToast = jasmine.createSpyObj<AppToastService>('AppToastService', ['success', 'error']);
    sentryTelemetry = jasmine.createSpyObj<SentryTelemetryService>('SentryTelemetryService', [
      'addFeatureBreadcrumb',
      'captureFeatureError',
    ]);

    pdfRendererService.destroy.and.resolveTo();
    pdfRendererService.loadDocument.and.resolveTo({ totalPages: 3 });
    pdfRendererService.renderPage.and.callFake(async (pageNumber: number) => ({
      width: 720,
      height: pageNumber * 1000,
      scale: 1,
    }));
    pdfRendererService.isRenderCancellationError.and.returnValue(false);
    stackNavigationService.backWithFallback.and.returnValue(Promise.resolve());
    appToast.success.and.returnValue(Promise.resolve());
    appToast.error.and.returnValue(Promise.resolve());

    spyOn(window, 'requestAnimationFrame').and.callFake((callback: FrameRequestCallback): number => {
      callback(16);
      return 1;
    });
    spyOnProperty(HTMLElement.prototype, 'clientWidth', 'get').and.callFake(function (this: HTMLElement): number {
      return this.classList?.contains('reader-page') ? 320 : 0;
    });
    spyOnProperty(HTMLElement.prototype, 'offsetTop', 'get').and.callFake(function (this: HTMLElement): number {
      const pageNumber = Number(this.dataset?.['pageNumber'] ?? '1');
      return (pageNumber - 1) * 1000;
    });

    await TestBed.configureTestingModule({
      imports: [BibleStudyReaderPage],
      providers: [
        { provide: BibleStudyService, useValue: bibleStudyService },
        { provide: BibleStudyPdfRendererService, useValue: pdfRendererService },
        { provide: ExternalBrowserService, useValue: externalBrowserService },
        { provide: StackNavigationService, useValue: stackNavigationService },
        { provide: AppToastService, useValue: appToast },
        { provide: SentryTelemetryService, useValue: sentryTelemetry },
        { provide: LocaleService, useClass: MockLocaleService },
        {
          provide: ActivatedRoute,
          useValue: {
            get snapshot() {
              return {
                paramMap: convertToParamMap({ id: routeId }),
              };
            },
          },
        },
      ],
    }).compileComponents();
  });

  it('loads the manual into the PDF.js document renderer instead of an iframe', fakeAsync(() => {
    bibleStudyService.getPublishedManualDetail.and.returnValue(of(manual));

    createComponent();
    flushReader();

    expect(pdfRendererService.loadDocument).toHaveBeenCalledWith('https://example.com/manual.pdf?X-Amz-Signature=fresh');
    expect(pdfRendererService.renderPage).toHaveBeenCalled();
    expect(page.totalPages).toBe(3);
    expect(page.isReaderReady).toBeTrue();
    expect(fixture.nativeElement.querySelector('[data-testid="pdf-canvas-document"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
    expect(fixture.nativeElement.querySelector('object')).toBeNull();
    expect(fixture.nativeElement.querySelector('embed')).toBeNull();
  }));

  it('keeps the compact toolbar fallback route and hides tabs', fakeAsync(() => {
    bibleStudyService.getPublishedManualDetail.and.returnValue(of(manual));

    createComponent();
    flushReader();

    const backButton = fixture.nativeElement.querySelector('ion-back-button');
    expect(backButton?.getAttribute('defaultHref')).toBe('/tabs/bible-study');
    expect(fixture.nativeElement.querySelector('[data-testid="tabs-bar"]')).toBeNull();
  }));

  it('shows a pdf-unavailable state when the PDF document fails to load', fakeAsync(() => {
    bibleStudyService.getPublishedManualDetail.and.returnValue(of(manual));
    pdfRendererService.loadDocument.and.rejectWith(new Error('Failed to fetch PDF'));

    createComponent();
    flushReader();

    expect(page.viewerState).toBe('error');
    expect(page.errorKind).toBe('pdf-unavailable');
    expect(fixture.nativeElement.querySelector('[data-testid="reader-pdf-error-state"]')).not.toBeNull();
  }));

  it('transitions startup exceptions to error instead of hanging on loading', fakeAsync(() => {
    bibleStudyService.getPublishedManualDetail.and.returnValue(of(manual));
    pdfRendererService.loadDocument.and.rejectWith(new TypeError('Promise.try is not a function'));

    createComponent();
    flushReader();

    expect(page.viewerState).toBe('error');
    expect(page.isLoading).toBeFalse();
    expect(page.errorKind).toBe('pdf-unavailable');
  }));

  it('retries cleanly after a startup failure', fakeAsync(() => {
    bibleStudyService.getPublishedManualDetail.and.returnValues(of(manual), of(manual));
    pdfRendererService.loadDocument.and.returnValues(
      Promise.reject(new TypeError('Promise.try is not a function')),
      Promise.resolve({ totalPages: 3 })
    );

    createComponent();
    flushReader();
    expect(page.viewerState).toBe('error');

    page.retryPdfLoad();
    flushReader();

    expect(pdfRendererService.loadDocument.calls.count()).toBe(2);
    expect(page.viewerState).toBe('ready');
    expect(page.totalPages).toBe(3);
  }));

  it('supports re-entry after leaving the page and renders again', fakeAsync(() => {
    bibleStudyService.getPublishedManualDetail.and.returnValues(
      of(manual),
      of({ ...manual, pdf_url: 'https://example.com/manual.pdf?X-Amz-Signature=second' })
    );

    createComponent();
    flushReader();
    expect(page.pdfSourceUrl).toContain('fresh');

    page.ionViewDidLeave();
    expect(page.pdfSourceUrl).toBeNull();

    page.ionViewWillEnter();
    fixture.detectChanges();
    flushReader();

    expect(bibleStudyService.getPublishedManualDetail.calls.count()).toBe(2);
    expect(pdfRendererService.loadDocument.calls.mostRecent().args[0]).toContain('second');
    expect(pdfRendererService.renderPage.calls.count()).toBeGreaterThan(3);
  }));

  it('re-renders pages when zoom changes', fakeAsync(() => {
    bibleStudyService.getPublishedManualDetail.and.returnValue(of(manual));

    createComponent();
    flushReader();
    const initialRenderCalls = pdfRendererService.renderPage.calls.count();

    page.zoomIn();
    fixture.detectChanges();
    flushReader();

    expect(page.zoomLevel).toBeGreaterThan(1);
    expect(pdfRendererService.cancelAllRenders).toHaveBeenCalled();
    expect(pdfRendererService.renderPage.calls.count()).toBeGreaterThan(initialRenderCalls);
  }));

  it('shares the current pdf url from the header action without downloading first', fakeAsync(() => {
    const navigatorShare = jasmine.createSpy('share').and.resolveTo();
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(false);
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      writable: true,
      value: navigatorShare,
    });

    createComponent();
    flushReader();
    page.sharePdf();
    flushReader();

    expect(navigatorShare).toHaveBeenCalledWith({
      title: 'Bible Study Manual',
      url: 'https://example.com/manual.pdf?X-Amz-Signature=fresh',
    });
  }));

  it('shows only try again and open externally actions in the pdf unavailable state', fakeAsync(() => {
    bibleStudyService.getPublishedManualDetail.and.returnValue(of(manual));
    pdfRendererService.loadDocument.and.rejectWith(new Error('Failed to fetch PDF'));

    createComponent();
    flushReader();

    const pdfErrorState = fixture.nativeElement.querySelector('[data-testid="reader-pdf-error-state"]');
    const renderedText = pdfErrorState?.textContent ?? '';
    expect(renderedText).toContain('Try Again');
    expect(renderedText).toContain('Open PDF externally');
    expect(renderedText).not.toContain('Download PDF');
  }));

  it('uses the shared stack navigation fallback for back navigation', fakeAsync(() => {
    bibleStudyService.getPublishedManualDetail.and.returnValue(of(manual));

    createComponent();
    flushReader();
    page.goBackToManual();
    flushMicrotasks();

    expect(stackNavigationService.backWithFallback).toHaveBeenCalledWith('/tabs/bible-study');
  }));

  it('opens the current PDF externally on demand', fakeAsync(() => {
    bibleStudyService.getPublishedManualDetail.and.returnValue(of(manual));
    externalBrowserService.openUrl.and.returnValue(Promise.resolve());

    createComponent();
    flushReader();
    page.openPdfExternally();
    flushMicrotasks();

    expect(externalBrowserService.openUrl).toHaveBeenCalledWith('https://example.com/manual.pdf?X-Amz-Signature=fresh');
  }));

  it('shows an invalid id error without calling the API', fakeAsync(() => {
    routeId = 'abc';
    bibleStudyService.getPublishedManualDetail.and.returnValue(of(manual));

    createComponent();
    flushReader();

    expect(bibleStudyService.getPublishedManualDetail).not.toHaveBeenCalled();
    expect(page.errorKind).toBe('invalid-id');
    expect(page.errorMessage).toBe('Invalid Bible Study manual ID.');
  }));

  it('shows the generic reader error when the manual request fails', fakeAsync(() => {
    bibleStudyService.getPublishedManualDetail.and.returnValue(throwError(() => new Error('network')));

    createComponent();
    flushReader();

    expect(page.errorKind).toBe('manual-load');
    expect(fixture.nativeElement.querySelector('[data-testid="reader-error-state"]')).not.toBeNull();
  }));
});
