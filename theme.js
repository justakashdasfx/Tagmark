/* Runs before first paint (loaded synchronously in <head>) so the saved theme never flashes. */
(function () {
  try {
    var t = localStorage.getItem('tagmark-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* ignore */ }
})();
