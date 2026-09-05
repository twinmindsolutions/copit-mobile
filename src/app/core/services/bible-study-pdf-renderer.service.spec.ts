import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import { resetPdfJsModuleForTests } from '../pdfjs/pdfjs-runtime';
import { BibleStudyPdfRendererService } from './bible-study-pdf-renderer.service';
import { SentryTelemetryService } from './sentry-telemetry.service';

describe('BibleStudyPdfRendererService', () => {
  const baseUri = 'https://example.com/app/';

  beforeEach(() => {
    TestBed.resetTestingModule();
    resetPdfJsModuleForTests();
    (pdfjsLib.GlobalWorkerOptions as { workerSrc?: string }).workerSrc = '';
  });

  const sentryTelemetryStub = {
    captureFeatureError: jasmine.createSpy('captureFeatureError'),
  };

  it('configures the worker to the copied app asset path', () => {
    TestBed.configureTestingModule({
      providers: [
        BibleStudyPdfRendererService,
        { provide: SentryTelemetryService, useValue: sentryTelemetryStub },
        {
          provide: DOCUMENT,
          useValue: {
            baseURI: baseUri,
          },
        },
      ],
    });

    TestBed.inject(BibleStudyPdfRendererService);

    expect(pdfjsLib.GlobalWorkerOptions.workerSrc).toBe(
      'https://example.com/app/assets/pdfjs/pdf.worker.bootstrap.mjs'
    );
    expect(pdfjsLib.GlobalWorkerOptions.workerSrc).not.toBe('/pdf.worker.min.mjs');
  });

  it('configures workerSrc before getDocument is called', async () => {
    const mockTask = {
      promise: Promise.resolve({ numPages: 4 }),
      destroy: jasmine.createSpy('destroy').and.resolveTo(),
    } as unknown as pdfjsLib.PDFDocumentLoadingTask;

    const getDocumentSpy = spyOn(pdfjsLib, 'getDocument').and.callFake(() => {
      expect(pdfjsLib.GlobalWorkerOptions.workerSrc).toContain('assets/pdfjs/pdf.worker.bootstrap.mjs');
      return mockTask;
    });

    TestBed.configureTestingModule({
      providers: [
        BibleStudyPdfRendererService,
        { provide: SentryTelemetryService, useValue: sentryTelemetryStub },
        {
          provide: DOCUMENT,
          useValue: {
            baseURI: baseUri,
          },
        },
      ],
    });

    const service = TestBed.inject(BibleStudyPdfRendererService);
    const result = await service.loadDocument('https://files.example.com/manual.pdf');

    expect(getDocumentSpy).toHaveBeenCalled();
    expect(result.totalPages).toBe(4);
  });
});
