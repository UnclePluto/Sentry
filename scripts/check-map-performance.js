// 浏览器性能回归：playwright-cli run-code 加载；提前打开待测生产大盘。
// 使用真实图层观测几何重建；不依赖编译产物中的变量名或绝对耗时阈值。
// oxlint-disable-next-line no-unused-expressions -- 此函数表达式由 playwright-cli run-code 执行。
async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole('button', { name: '切换到 2D 地图', exact: true })
    .click();
  const pause = page.getByRole('button', { name: '暂停月份推进' });
  if (await pause.count()) await pause.click();
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const stage = document.querySelector('.map-stage');
    const key = Object.keys(stage).find((key) =>
      key.startsWith('__reactFiber$'),
    );
    const findLayers = (fiber) => {
      if (!fiber) return null;
      if (Array.isArray(fiber.memoizedProps?.layers))
        return fiber.memoizedProps.layers;
      return findLayers(fiber.child) || findLayers(fiber.sibling);
    };
    const layers = findLayers(stage[key]);
    if (!layers) throw new Error('未找到实际地图图层');
    const flat = layers.find((layer) => layer.id === 'flat-region-fills');
    const prototype = Object.getPrototypeOf(flat);
    const original = prototype._updateStateJSON;
    window.__mapGeometryUpdates = 0;
    prototype._updateStateJSON = function (...args) {
      if (this.id === 'flat-region-fills') window.__mapGeometryUpdates++;
      return original.apply(this, args);
    };
    window.__restoreMapProbe = () => {
      prototype._updateStateJSON = original;
    };
  });
  let updates;
  try {
    for (const name of [
      '查看四川省',
      '查看广东省',
      '查看四川省',
      '查看广东省',
    ]) {
      const label = page.getByRole('button', { name, exact: true });
      await label.hover();
      await page.waitForFunction((name) => {
        const label = document.querySelector(
          `.region-label[aria-label="${name}"]`,
        );
        return label?.classList.contains('active');
      }, name);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    }
    updates = await page.evaluate(() => window.__mapGeometryUpdates);
  } finally {
    await page.evaluate(() => {
      window.__restoreMapProbe();
      delete window.__restoreMapProbe;
    });
  }
  if (updates > 0) throw new Error(`悬停导致2D几何数据重建 ${updates} 次`);
  console.log('通过：连续跨省悬停未重建2D几何数据');
}
