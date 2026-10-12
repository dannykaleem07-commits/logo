// owned by intake-web
/** Upload queue for case bundles (docs/SMART-INTAKE.md §11.3): batching, concurrency 2, folder walk, retry, refusals. */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddFilesResult } from '../../../api/bundlesApi';
import { DEFAULT_LIMITS } from '../../../api/uploads';
import { filesFromDataTransfer, isSkippableName, resetUploadQueues, rowPercent, uploadQueueFor, UploadQueue, walkEntries, type EntryLike, type UploadTransport } from './uploadQueue';

const MIB = 1024 * 1024;

/** A File-like object with a size, without allocating its bytes. */
function file(name: string, size = 1000): File {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

function result(files: File[]): AddFilesResult {
  return {
    files: files.map((f, i) => ({ fileId: `bf-${f.name}`, itemId: `it-${i}`, filename: f.name, outcome: 'added' as const })),
    bundle: {} as AddFilesResult['bundle'],
  };
}

/** A transport whose requests stay open until released, so concurrency can be observed. */
function heldTransport() {
  const open: Array<{ kind: 'batch' | 'chunked'; files: File[]; release: () => void; fail: (e: Error) => void; progress: (s: number, t: number) => void }> = [];
  let maxInFlight = 0;
  let inFlight = 0;
  const hold = (kind: 'batch' | 'chunked', files: File[], progress: (s: number, t: number) => void) =>
    new Promise<AddFilesResult>((resolve, reject) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      open.push({
        kind,
        files,
        progress,
        release: () => {
          inFlight -= 1;
          resolve(result(files));
        },
        fail: (e) => {
          inFlight -= 1;
          reject(e);
        },
      });
    });
  const transport: UploadTransport = {
    limits: async () => DEFAULT_LIMITS,
    sendBatch: (_id, files, onProgress) => hold('batch', files, onProgress),
    sendChunked: (_id, f, onProgress) => hold('chunked', [f], onProgress),
  };
  return { transport, open, max: () => maxInFlight };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => resetUploadQueues());

describe('UploadQueue', () => {
  it('sends ≤ 10 files per request, at most 2 requests at a time, large files in parts', async () => {
    const t = heldTransport();
    const q = new UploadQueue('b1', 'Jane Doe – Corsa crash', t.transport);
    const files = [...Array.from({ length: 25 }, (_, i) => file(`IMG_${i}.jpg`, MIB)), file('scan.pdf', 100 * MIB), file('video.mov', 3000 * MIB)];
    await q.add(files);
    await tick();
    expect(t.open.length).toBe(2);
    expect(q.active).toBe(2);
    expect(t.open[0]!.files).toHaveLength(10);
    // the refused one is marked straight away with the import folder
    const refused = q.getSnapshot().find((r) => r.name === 'video.mov')!;
    expect(refused.status).toBe('refused');
    expect(refused.error).toContain('inbox\\intake\\Jane Doe – Corsa crash\\');
    // progress of a batch spreads over its files
    t.open[0]!.progress(5 * MIB, 10 * MIB);
    const rows = q.getSnapshot();
    expect(rowPercent(rows.find((r) => r.name === 'IMG_0.jpg')!)).toBe(100);
    expect(rowPercent(rows.find((r) => r.name === 'IMG_6.jpg')!)).toBe(0);
    // drain
    while (t.open.some((o) => o)) {
      const next = t.open.shift()!;
      next.release();
      await tick();
      await tick();
    }
    await q.idle();
    expect(t.max()).toBe(2);
    const done = q.getSnapshot();
    expect(done.filter((r) => r.status === 'sent')).toHaveLength(26);
    expect(done.find((r) => r.name === 'scan.pdf')!.fileId).toBe('bf-scan.pdf');
    expect(done.find((r) => r.name === 'IMG_3.jpg')!.fileId).toBe('bf-IMG_3.jpg');
  });

  it('a failed request marks its files; Retry sends a file again on its own', async () => {
    const t = heldTransport();
    const q = new UploadQueue('b1', 'x', t.transport);
    let changes = 0;
    q.setOnServerChange(() => (changes += 1));
    await q.add([file('a.pdf'), file('b.pdf')]);
    await tick();
    t.open.shift()!.fail(new Error('Cannot reach the ClaimDesk API'));
    await q.idle();
    expect(q.getSnapshot().map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(q.getSnapshot()[0]!.error).toBe('Cannot reach the ClaimDesk API');
    q.retry(q.getSnapshot()[0]!.key);
    await tick();
    await tick();
    expect(t.open).toHaveLength(1);
    expect(t.open[0]!.files.map((f) => f.name)).toEqual(['a.pdf']);
    t.open.shift()!.release();
    await q.idle();
    expect(q.getSnapshot().map((r) => r.status)).toEqual(['sent', 'failed']);
    expect(changes).toBe(1);
    q.clearFinished();
    expect(q.getSnapshot().map((r) => r.name)).toEqual(['b.pdf']);
  });

  it('notifies subscribers with a new snapshot on every change', async () => {
    const t = heldTransport();
    const q = uploadQueueFor('b2', 'Name', t.transport);
    expect(uploadQueueFor('b2')).toBe(q);
    const seen: number[] = [];
    const off = q.subscribe(() => seen.push(q.getSnapshot().length));
    const before = q.getSnapshot();
    await q.add([file('Thumbs.db'), file('.DS_Store'), file('one.pdf')]);
    expect(q.getSnapshot()).not.toBe(before);
    expect(q.getSnapshot().map((r) => r.name)).toEqual(['one.pdf']);
    off();
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('folders', () => {
  const fileEntry = (name: string): EntryLike => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(file(name)) });
  /** readEntries hands back at most 2 entries per call, like browsers do in pages of ~100. */
  const dirEntry = (name: string, children: EntryLike[]): EntryLike => ({
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let i = 0;
      return {
        readEntries: (ok) => {
          const page = children.slice(i, i + 2);
          i += 2;
          ok(page);
        },
      };
    },
  });

  it('walks folders recursively and skips hidden files, Thumbs.db and desktop.ini', async () => {
    const tree = [
      dirEntry('Jane Doe', [fileEntry('V5C.pdf'), fileEntry('Thumbs.db'), fileEntry('desktop.ini'), fileEntry('.hidden'), dirEntry('photos', [fileEntry('IMG_1.jpg'), fileEntry('IMG_2.jpg'), dirEntry('__MACOSX', [fileEntry('._IMG_1.jpg')])]), fileEntry('form.pdf')]),
      fileEntry('loose.eml'),
    ];
    const files = await walkEntries(tree);
    expect(files.map((f) => f.name)).toEqual(['V5C.pdf', 'IMG_1.jpg', 'IMG_2.jpg', 'form.pdf', 'loose.eml']);
  });

  it('a drop uses entries when the browser offers them, else the file list', async () => {
    const withEntries = { items: [{ kind: 'file', webkitGetAsEntry: () => dirEntry('d', [fileEntry('a.pdf')]) }] as unknown as DataTransferItemList, files: [] as unknown as FileList };
    expect((await filesFromDataTransfer(withEntries)).map((f) => f.name)).toEqual(['a.pdf']);
    const plain = { items: [] as unknown as DataTransferItemList, files: [file('b.pdf'), file('desktop.ini')] as unknown as FileList };
    expect((await filesFromDataTransfer(plain)).map((f) => f.name)).toEqual(['b.pdf']);
    expect(await filesFromDataTransfer(null)).toEqual([]);
  });

  it('skippable names', () => {
    expect(isSkippableName('Thumbs.db')).toBe(true);
    expect(isSkippableName('DESKTOP.INI')).toBe(true);
    expect(isSkippableName('folder/.DS_Store')).toBe(true);
    expect(isSkippableName('V5C.pdf')).toBe(false);
  });
});
