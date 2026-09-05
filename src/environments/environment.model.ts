export interface CopitMobileEnvironment {
  production: boolean;
  apiBaseUrl: string;
  appOrigin: string;
  appVersion: string;
  stripePublishableKey: string;
  stripeMerchantDisplayName: string;
  // Native Apple Pay Merchant ID. Expected format: merchant.<reverse-domain-name>
  stripeApplePayMerchantId: string;
  sentryEnabled: boolean;
  sentryDsn: string;
  sentryEnvironment: string;
  sentryRelease: string;
}
