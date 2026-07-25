import * as Sentry from "@sentry/react";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const configuredSampleRate = Number(
  process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.05",
);

Sentry.init({
  dsn,
  enabled: process.env.NODE_ENV === "production" && Boolean(dsn),
  sendDefaultPii: false,
  integrations: [
    Sentry.browserTracingIntegration({
      instrumentNavigation: false,
    }),
  ],
  tracesSampleRate:
    Number.isFinite(configuredSampleRate) && configuredSampleRate >= 0
      ? Math.min(configuredSampleRate, 1)
      : 0.05,
});

export function onRouterTransitionStart(
  href: string,
  navigationType: string,
): void {
  const client = Sentry.getClient();
  if (!client) return;

  Sentry.startBrowserTracingNavigationSpan(
    client,
    {
      name: href,
      op: "navigation",
      attributes: {
        "navigation.type": navigationType,
      },
    },
    { url: href },
  );
}
