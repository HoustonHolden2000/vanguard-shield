const sharp = require('sharp');
const ZXing = require('@zxing/library');

(async () => {
  // Create a test image (gray square - should fail gracefully)
  const buf = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 200, b: 200 } } })
    .jpeg().toBuffer();

  console.log('Test image size:', buf.length, 'bytes');

  const { MultiFormatReader, BarcodeFormat, DecodeHintType, RGBLuminanceSource, BinaryBitmap, HybridBinarizer } = ZXing;
  const reader = new MultiFormatReader();

  const attempts = [
    { label: 'Original 1600px', resize: 1600, sharpen: false, normalize: false, tryHarder: false },
    { label: 'Sharpen+Normalize', resize: 1600, sharpen: true, normalize: true, tryHarder: true },
    { label: 'High-res 2400px', resize: 2400, sharpen: true, normalize: false, tryHarder: true },
  ];

  for (const attempt of attempts) {
    try {
      let pipeline = sharp(buf).rotate().resize(attempt.resize, null, { withoutEnlargement: true });
      if (attempt.sharpen) pipeline = pipeline.sharpen();
      if (attempt.normalize) pipeline = pipeline.normalize();
      pipeline = pipeline.grayscale().raw();

      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      console.log('[' + attempt.label + '] channels=' + info.channels + ' size=' + info.width + 'x' + info.height + ' data=' + data.length + ' expected=' + (info.width * info.height));

      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]);
      if (attempt.tryHarder) hints.set(DecodeHintType.TRY_HARDER, true);
      reader.setHints(hints);

      const src = new RGBLuminanceSource(new Uint8ClampedArray(data), info.width, info.height);
      const bitmap = new BinaryBitmap(new HybridBinarizer(src));
      const result = reader.decode(bitmap);
      console.log('[' + attempt.label + '] DECODED:', result.getText().substring(0, 80));
    } catch (e) {
      console.log('[' + attempt.label + '] Failed:', e.message || String(e));
    }
  }
  console.log('Pipeline test complete - failures expected (no barcode in test image)');
})();
