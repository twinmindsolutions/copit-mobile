import { appVersion, sentryRelease } from './app-version';
import type { CopitMobileEnvironment } from './environment.model';

export const environment: CopitMobileEnvironment = {
  production: true,
  apiBaseUrl: 'https://copit-api-production.up.railway.app/api',
  appOrigin: 'https://copit-production-97631.web.app',
  appVersion,
  stripePublishableKey: 'pk_live_51THm0S4tk8nFl69pks57XRVERr8Y65ENIuRi6JpcYven8OXWqjIIkJ2PR6Vt49msvMwVDAPCnMsxYQngysnfkxyn00sTkuEh0I',
  stripeMerchantDisplayName: 'COP Italy',
  stripeApplePayMerchantId: '',
  sentryEnabled: true,
  sentryDsn: 'https://1c980c083b10f18d66a13cca5349ad92@o4511588679483392.ingest.de.sentry.io/4511588682694736',
  sentryEnvironment: 'production',
  sentryRelease,
};
