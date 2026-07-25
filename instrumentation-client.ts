import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const configuredSampleRate = Number(
  process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.05",
);

Sentry.init({
  dsn,
  enabled: process.env.NODE_ENV === "production" && Boolean(dsn),
  sendDefaultPii: false,
  tracesSampleRate:
    Number.isFinite(configuredSampleRate) && configuredSampleRate >= 0
      ? Math.min(configuredSampleRate, 1)
      : 0.05,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
