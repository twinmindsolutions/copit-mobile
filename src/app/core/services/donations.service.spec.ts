import { HttpErrorResponse } from '@angular/common/http';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { of } from 'rxjs';

import { AuthService } from './auth.service';
import { DonationsService } from './donations.service';
import { SentryTelemetryService } from './sentry-telemetry.service';

class MockAuthService {
  accessTokenSnapshot: string | null = 'member-token';
  isAuthenticatedSnapshot = true;
  currentUserSnapshot = null;
  getCurrentUser = jasmine.createSpy().and.returnValue(of(null));
}

class MockSentryTelemetryService {
  addFeatureBreadcrumb(): void {}
  captureFeatureError(): void {}
}

describe('DonationsService', () => {
  let service: DonationsService;
  let httpMock: HttpTestingController;
  let authService: MockAuthService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        DonationsService,
        { provide: AuthService, useClass: MockAuthService },
        { provide: SentryTelemetryService, useClass: MockSentryTelemetryService },
      ],
    }).compileComponents();

    service = TestBed.inject(DonationsService);
    httpMock = TestBed.inject(HttpTestingController);
    authService = TestBed.inject(AuthService) as unknown as MockAuthService;
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('sends donation_id and transaction_reference when verifying mobile payments', () => {
    let responseBody: unknown;

    service
      .verifyMobilePayment({
        donation_id: 21,
        transaction_reference: 'TRX-1001',
      })
      .subscribe((response) => {
        responseBody = response;
      });

    const request = httpMock.expectOne((req) => {
      return (
        req.url.endsWith('/api/donations/verify-mobile-payment/') &&
        req.params.get('donation_id') === '21' &&
        req.params.get('transaction_reference') === 'TRX-1001'
      );
    });

    expect(request.request.method).toBe('GET');
    request.flush({ verified: true, donation_id: 21, transaction_reference: 'TRX-1001' });

    expect(responseBody).toEqual({
      verified: true,
      donation_id: 21,
      transaction_reference: 'TRX-1001',
    });
  });

  it('loads donation types from the ordinary public category endpoint without requesting finance offerings', () => {
    let categories: unknown;

    service.getPublicDonationCategories(42).subscribe((response) => {
      categories = response;
    });

    const request = httpMock.expectOne((req) => {
      return req.url.endsWith('/api/public/branches/42/donation-categories/')
        && !req.params.has('is_financial_reporting_special_offering');
    });
    expect(request.request.method).toBe('GET');
    request.flush([{ id: 1, name: 'Tithe' }]);

    expect(categories).toEqual([{ id: 1, name: 'Tithe' }]);
  });

  it('does not attempt auth refresh when a protected donation request returns 403', fakeAsync(() => {
    let receivedError: HttpErrorResponse | null = null;

    service
      .createRecurringDonation({
        church_id: 4,
        category_id: 8,
        amount: 75,
        interval: 'monthly',
      })
      .subscribe({
        error: (error) => {
          receivedError = error;
        },
      });

    const request = httpMock.expectOne((req) => req.url.endsWith('/api/donations/recurring/create/'));
    expect(request.request.headers.get('Authorization')).toBe('Bearer member-token');
    request.flush(
      { detail: 'You do not have permission to use monthly giving for this account.' },
      { status: 403, statusText: 'Forbidden' }
    );

    flushMicrotasks();

    expect(authService.getCurrentUser).not.toHaveBeenCalled();
    expect(receivedError).toEqual(jasmine.any(HttpErrorResponse));
    expect((receivedError as unknown as HttpErrorResponse).status).toBe(403);
  }));
});
