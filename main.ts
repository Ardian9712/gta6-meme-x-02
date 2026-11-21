import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_WIDTH = 1024;
const REQUIRED_HEIGHT = 1024;
const MAX_BYTES = 1_048_576;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

type ImageDimensions = { format: 'JPEG' | 'PNG'; width: number; height: number };

function dimensions(image: Buffer): ImageDimensions {
  // Recognize PNG headers too, so a wrong-size PNG receives a dimensions error.
  if (image.subarray(0, 8).equals(PNG_SIGNATURE)) {
    if (image.length < 33 || image.readUInt32BE(8) !== 13 ||
        image.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('Invalid PNG: missing or truncated IHDR header.');
    }
    return {
      format: 'PNG',
      width: image.readUInt32BE(16),
      height: image.readUInt32BE(20),
    };
  }

  if (image.length < 2 || image.readUInt16BE(0) !== 0xffd8) {
    throw new Error('Unsupported image format: expected JPEG or PNG.');
  }

  let offset = 2;
  while (offset < image.length) {
    if (image[offset] !== 0xff) {
      throw new Error('Invalid JPEG: expected a segment marker.');
    }
    while (offset < image.length && image[offset] === 0xff) offset += 1;
    if (offset >= image.length) break;

    const marker = image[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > image.length) {
      throw new Error('Invalid JPEG: truncated segment length.');
    }

    const length = image.readUInt16BE(offset);
    if (length < 2 || offset + length > image.length) {
      throw new Error('Invalid JPEG: truncated or invalid segment.');
    }
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (length < 8) throw new Error('Invalid JPEG: truncated frame header.');
      return {
        format: 'JPEG',
        width: image.readUInt16BE(offset + 5),
        height: image.readUInt16BE(offset + 3),
      };
    }
    offset += length;
  }
  throw new Error('Invalid JPEG: image dimensions were not found.');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main(): Promise<void> {
  const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'source-image.jpg');
  const source = await readFile(sourcePath);
  const image = dimensions(source);
  if (image.width !== REQUIRED_WIDTH || image.height !== REQUIRED_HEIGHT) {
    throw new Error(
      `Invalid image dimensions: expected ${REQUIRED_WIDTH}x${REQUIRED_HEIGHT}, ` +
      `got ${image.width}x${image.height} (${image.format}).`,
    );
  }
  if (image.format !== 'JPEG') {
    throw new Error(`Invalid source format: expected JPEG, got ${image.format}.`);
  }
  if (source.length > MAX_BYTES) {
    throw new Error(`Image exceeds the ${MAX_BYTES}-byte limit: got ${source.length} bytes.`);
  }

  const sourceHash = sha256(source);
  const outputDirectory = resolve(process.env.MAKEFUN_OUTPUT_DIR || '/output');
  const outputPath = join(outputDirectory, 'entry.png');
  await mkdir(outputDirectory, { recursive: true });
  // Preserve the JPEG bytes exactly; entry.png is the required output filename.
  await writeFile(outputPath, source);

  const written = await readFile(outputPath);
  if (written.length !== source.length) {
    throw new Error(`Output size mismatch: expected ${source.length}, got ${written.length} bytes.`);
  }
  const writtenHash = sha256(written);
  if (writtenHash !== sourceHash) {
    throw new Error(`Output SHA-256 mismatch: expected ${sourceHash}, got ${writtenHash}.`);
  }
  console.log(`Success: wrote ${outputPath} (${written.length} bytes; SHA-256 ${writtenHash}).`);
}

main().catch((error: unknown) => {
  console.error(`Entry generation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
