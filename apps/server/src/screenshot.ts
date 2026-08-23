export function buildScreenshotArgv(browser: string, url: string, target: string, profileDir: string): string[] {
  return [
    browser,
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    // Без этого флага снимок иногда уходит раньше layout/paint: canvas читает
    // window.innerWidth как 0, WebGL-кадр не успевает отрисоваться.
    "--run-all-compositor-stages-before-draw",
    `--user-data-dir=${profileDir}`,
    "--window-size=1280,860",
    "--virtual-time-budget=5000",
    `--screenshot=${target}`,
    url,
  ];
}
