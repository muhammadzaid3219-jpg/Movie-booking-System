/**
 * Draws a QR code on a canvas.
 *
 *   QR.render(canvasElement, 'MBS1234ABCD', { size: 168 });
 *
 * The encoding itself comes from qrcode-generator (js/qrcode-generator.js, MIT,
 * Kazuhiko Arase). An earlier hand-written encoder produced codes that looked
 * right but no scanner could read, so this file only does the drawing.
 */
const QR = (() => {
  function render(canvas, text, { size = 160, quiet = 4, dark = '#000', light = '#fff' } = {}) {
    if (typeof qrcode !== 'function') throw new Error('QR library not loaded');

    const code = qrcode(0, 'M');        // 0 = smallest version that fits
    code.addData(String(text), 'Byte');
    code.make();

    const count = code.getModuleCount();
    const modules = count + quiet * 2;
    // At least 4px per module, or phone cameras struggle to resolve it.
    const scale = Math.max(4, Math.floor(size / modules));

    canvas.width = canvas.height = modules * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = dark;
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (code.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    return canvas;
  }

  return { render };
})();
