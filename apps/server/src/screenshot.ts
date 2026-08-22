export function buildScreenshotArgv(browser: string, url: string, target: string, profileDir: string): string[] {
  return [
    browser,
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profileDir}`,
    "--window-size=1280,860",
    "--virtual-time-budget=5000",
    `--screenshot=${target}`,
    url,
  ];
}
