// A rough "Firefox on Windows" from a User-Agent, for the sessions list. Order matters: Edge and
// Opera say Chrome, Chrome says Safari, and iPads may say Macintosh.

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'macOS'],
  [/Linux/, 'Linux'],
]

export function describeDevice(userAgent: string | null): { browser: string | null; os: string | null } {
  if (!userAgent) return { browser: null, os: null }
  return {
    browser: BROWSERS.find(([re]) => re.test(userAgent))?.[1] ?? null,
    os: SYSTEMS.find(([re]) => re.test(userAgent))?.[1] ?? null,
  }
}
