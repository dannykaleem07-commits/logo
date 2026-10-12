// owned by intake-server
/** The synthetic smart-intake files are what they claim to be (docs/SMART-INTAKE.md §16.3). */
import { describe, expect, it } from 'vitest';
import { extractExif } from '../services/evidence.js';
import { photoGps } from '../intake/image.js';
import { exifTiff, jpegPhoto, pngPhoto } from './fixtures/smartIntake/files.js';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;

describe('synthetic photos', () => {
  it('builds a TIFF block', () => {
    expect(exifTiff({ taken: '2026:10:01 09:05:00' }).subarray(0, 4).toString('latin1')).toBe('MM\0*');
  });
  it('the evidence EXIF reader reads the PNG eXIf chunk', async () => {
    const png = pngPhoto(64, 48, 3, { taken: '2026:10:01 09:05:00', gps: { lat: 51.5, lon: -0.12 } });
    const exif = await extractExif(png, 'image/png', logger);
    expect(exif?.dateTimeOriginal?.slice(0, 16)).toBe('2026-10-01T09:05');
    // the evidence summary does not carry GPS today (its exifr `pick` list omits the GPS tags); intake reads it itself
    expect((await photoGps(png))?.lat).toBeCloseTo(51.5, 2);
  });
  it('the evidence EXIF reader reads the JPEG APP1 segment', async () => {
    const jpg = jpegPhoto(64, 48, 3, { taken: '2026:10:01 09:05:00', gps: { lat: 51.5, lon: -0.12 }, software: 'Example Editor 2' });
    const exif = await extractExif(jpg, 'image/jpeg', logger);
    expect(exif?.dateTimeOriginal?.slice(0, 16)).toBe('2026-10-01T09:05');
    expect((await photoGps(jpg))?.lon).toBeCloseTo(-0.12, 2);
    expect(exif?.software).toBe('Example Editor 2');
  });
});
