/* Show the already published 30-day summary while the full sales app loads. */
(async () => {
  'use strict';
  const view = new URLSearchParams(location.search).get('view') || 'sales';
  if (view !== 'sales') return;

  const get = id => document.getElementById(id);
  const amount = new Intl.NumberFormat('en-US', {style:'currency', currency:'USD'});
  const units = new Intl.NumberFormat('zh-CN');
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const platformNames = {Amazon:'Amazon', Shopify:'独立站', Wayfair:'Wayfair'};
  const controller = new AbortController();
  const stop = () => controller.abort();
  window.addEventListener('pagehide', stop, {once:true});
  window.addEventListener('dashboard-ready', stop, {once:true});

  try {
    const response = await fetch('./index.html', {signal:controller.signal, cache:'no-cache'});
    if (!response.ok) return;
    const source = new DOMParser().parseFromString(await response.text(), 'text/html');
    const summary = JSON.parse(source.getElementById('bossSummary')?.textContent || 'null');
    const current = summary?.current;
    if (get('loading').hidden || !current || !date.test(current.start) || !date.test(current.end)
      || ![current.amount, current.lower, current.orders].every(Number.isFinite)) return;

    const lower = units.format(current.lower);
    get('preview-period').textContent = '美西 ' + current.start + ' 至 ' + current.end + ' · 已核范围';
    get('preview-amount').textContent = amount.format(current.amount);
    get('preview-units').textContent = current.lower === current.upper ? lower
      : Number.isFinite(current.upper) ? lower + '–' + units.format(current.upper) : '≥' + lower;
    get('preview-orders').textContent = units.format(current.orders);
    const platforms = get('preview-platforms');
    for (const row of summary.platforms || []) {
      if (!Object.hasOwn(platformNames, row.platform) || !Number.isFinite(row.current?.amount)) continue;
      const group = document.createElement('div');
      const name = document.createElement('dt');
      const value = document.createElement('dd');
      name.textContent = platformNames[row.platform];
      value.textContent = amount.format(row.current.amount);
      group.append(name, value);
      platforms.append(group);
    }
    get('sales-preview').hidden = false;
    get('loading').classList.add('has-preview');
  } catch (_) {
    // The full details app can load independently of the summary.
  } finally {
    window.removeEventListener('pagehide', stop);
    window.removeEventListener('dashboard-ready', stop);
  }
})();
