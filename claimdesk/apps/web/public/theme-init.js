/* ClaimDesk: apply the Light / Dark / System choice before the first paint (see src/lib/theme.ts, kept in step).
 * A same-origin file because the app's Content-Security-Policy allows no inline scripts. */
(function () {
  var setting = 'system';
  try {
    var saved = window.localStorage.getItem('claimdesk.theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') setting = saved;
  } catch (e) {
    /* blocked storage: System */
  }
  var dark = setting === 'dark' || (setting === 'system' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-theme-setting', setting);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0e1319' : '#072647');
})();
