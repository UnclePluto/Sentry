// 浏览器回归：用 playwright-cli run-code 加载；提前打开待测大盘。
// 捕获并主动触发真实 30 秒刷新回调，检查整张地图不会重新淡出。
async () => {
  await page.addInitScript(() => {
    const interval = window.setInterval;
    window.setInterval = function(fn, delay, ...args) {
      if (delay === 30000) window.__refreshMap = () => fn(...args);
      return interval(fn, delay, ...args);
    };
    window.__mapFades = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function(frames, options) {
      if (this.classList.contains('map-scene')) window.__mapFades.push(frames);
      return animate.call(this, frames, options);
    };
  });
  await page.reload();
  await page.waitForFunction(() => window.__refreshMap && window.__mapFades.length > 0);
  await page.evaluate(() => { window.__mapFades = []; window.__originalMapScene = document.querySelector('.map-scene'); });
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.__refreshMap());
    await page.waitForTimeout(800);
  }
  if (!await page.evaluate(() => window.__originalMapScene === document.querySelector('.map-scene'))) throw new Error('刷新不应重建地图节点');
  const fades = await page.evaluate(() => window.__mapFades);
  console.log(JSON.stringify({refreshFades:fades}));
  if (fades.some(frames => frames.some(f => Number(f.opacity) < 1))) throw new Error('后台30秒刷新让地图透明度下降并重新渐显');
}
