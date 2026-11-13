// Generate the shipped icon sizes from the supplied artwork, preserving alpha
// and aspect ratio. Commit the generated PNGs alongside the source image.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'src', 'icons');
const SOURCE = join(OUT_DIR, 'icon.png');
const SIZES = [16, 32, 48, 128];

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const path = join(OUT_DIR, `icon-${size}.png`);
  await sharp(SOURCE)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toFile(path);
  console.log(`wrote ${path.replace(`${ROOT}/`, '')}`);
}
