// 浏览器回归：playwright-cli run-code 加载；演示数据全国地图已打开。
// oxlint-disable-next-line no-unused-expressions -- 由 playwright-cli 执行。
async () => {
  await page
    .getByRole('button', { name: '切换到 2D 地图', exact: true })
    .click();
  const pause = page.getByRole('button', { name: '暂停月份推进' });
  if (await pause.count()) await pause.click();
  await page.locator('.time-months button').last().click();
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    window.__transitionFillChanges = 0;
    window.__transitionCount = 0;
    const seen = new WeakSet();
    // oxlint-disable-next-line typescript/unbound-method -- 下方 apply 显式保留原始 this。
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const svg = this.closest?.('.map-transition-layer');
      if (svg && !seen.has(svg)) {
        seen.add(svg);
        window.__transitionCount++;
        new MutationObserver((records) => {
          window.__transitionFillChanges += records.filter(
            (r) => r.attributeName === 'fill',
          ).length;
        }).observe(svg, {
          subtree: true,
          attributes: true,
          attributeFilter: ['fill'],
        });
      }
      return animate.apply(this, args);
    };
    window.__restoreTransitionProbe = () => {
      Element.prototype.animate = animate;
    };
  });
  try {
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes('/api/dashboard?') &&
          response.url().includes('from=') &&
          response.ok(),
      ),
      page.locator('.time-months button').first().click(),
    ]);
    await page.getByRole('button', { name: '查看四川省', exact: true }).click();
    await page.waitForFunction(
      () =>
        window.__transitionCount >= 2 &&
        !document.querySelector('.map-transition-layer'),
    );
    const changes = await page.evaluate(() => window.__transitionFillChanges);
    if (changes)
      throw new Error(`月份切换中下钻，过渡快照颜色变化 ${changes} 次`);
  } finally {
    await page.evaluate(() => {
      window.__restoreTransitionProbe();
      delete window.__restoreTransitionProbe;
    });
  }
  console.log('通过：月份切换中下钻，退场/入场快照颜色稳定');
}
