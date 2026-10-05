// Next runs this before the app hydrates (instrumentation-client). Only the tour build does
// anything here (next.config.ts): it puts this UI on a simulated lab in a plain browser (src/tour/),
// before any page has made its first request. In the desktop app and on an edge the condition is
// false at build time and the tour is not even bundled.
if (process.env.NEXT_PUBLIC_IVORYOS_TOUR === '1') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- inside the build-time condition, so other builds drop it
  require('./tour/install').installTour();
}

export {};
