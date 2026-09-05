import { appVersion, sentryRelease } from './app-version';
import type { CopitMobileEnvironment } from './environment.model';

export const environment: CopitMobileEnvironment = {
  production: false,
  apiBaseUrl: 'https://copit-api-staging.up.railway.app/api',
  appOrigin: 'https://copit-staging.web.app',
  appVersion,
  stripePublishableKey: 'pk_test_51THm0c5TkhnH7UiO7vLQPQiejjd6Fre5rY23sjYXZySj8t6WYsZDYsPkiO2kbhaktejllSv6XXdoRyS2sYxpDst700DkaOG4pC',
  stripeMerchantDisplayName: 'COP Italy',
  stripeApplePayMerchantId: 'COP Italy',
  sentryEnabled: false,
  sentryDsn: 'https://1c980c083b10f18d66a13cca5349ad92@o4511588679483392.ingest.de.sentry.io/4511588682694736',
  sentryEnvironment: 'staging',
  sentryRelease,
};
