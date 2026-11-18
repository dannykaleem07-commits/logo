'use strict';
/*
 * End-to-end test of the real desktop app in real Electron: main.js + preload.js + vehicledata.js + ai.js + the app page.
 *
 *   Windows:  npx electron tools/electron-e2e.js
 *   Linux:    xvfb-run -a npx electron --no-sandbox tools/electron-e2e.js
 *
 * Nothing reaches DVLA, DVSA or Anthropic: every https request the app makes through net.fetch is answered by
 * protocol.handle('https') below. userData, temp and documents point into a fresh temporary folder; save dialogs,
 * shell and the crash / hang message boxes are stubbed (one real message box is shown and closed by its AbortSignal).
 * The page is driven through the real preload bridge (window.desktop), so the main process's sender checks see real
 * frames; backups are streamed to real files, and the renderer is really killed and reloaded at the end.
 * Exit code 0 means every check passed.
 */
const { app, BrowserWindow, dialog, shell, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SECOND = process.argv.includes('--second-instance');
// child run: start a backup, then close the window ('close') or quit the app ('quit') while it is open
const QUIT_MODE = (process.argv.find((a) => a.startsWith('--quit-during-backup=')) || '').split('=')[1] || '';
const OUT = SECOND || QUIT_MODE ? process.env.ERS_E2E_OUT : fs.mkdtempSync(path.join(os.tmpdir(), 'ers-e2e-'));
if (!OUT) { console.error('ERS_E2E_OUT not set'); process.exit(9); }
if (!SECOND && !QUIT_MODE) for (const d of ['userData', 'temp', 'docs']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
app.setPath('userData', path.join(OUT, 'userData'));
app.setPath('temp', path.join(OUT, 'temp'));
app.setPath('documents', path.join(OUT, 'docs'));
const childArgs = (arg) => (process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', __filename, arg] : [__filename, arg]);

if (SECOND) {
  require(path.join(ROOT, 'main.js')); // must quit straight away: the first instance holds the single-instance lock
  setTimeout(() => process.exit(7), 20000);
} else if (QUIT_MODE) {
  // Its own userData, so it has its own single-instance lock. Exits 0 once main.js has let the app quit.
  dialog.showSaveDialog = async (a, b) => ({ canceled: false, filePath: path.join(OUT, 'docs', path.basename((b || a).defaultPath)) });
  require(path.join(ROOT, 'main.js'));
  app.once('browser-window-created', (_e, win) => {
    win.webContents.once('did-finish-load', async () => {
      try {
        const r = await win.webContents.executeJavaScript(`desktop.backup.begin({ fileName: 'quit-test' }).then(async (b) => ({ b, w: b.ok ? await desktop.backup.write(b.id, 'x'.repeat(1e6)) : null }))`, true);
        const parts = fs.readdirSync(path.join(OUT, 'docs')).filter((f) => f.endsWith('.part'));
        fs.writeFileSync(path.join(OUT, 'state.json'), JSON.stringify({ r, parts }));
        if (QUIT_MODE === 'close') win.close(); else app.quit();
      } catch (e) { fs.writeFileSync(path.join(OUT, 'state.json'), JSON.stringify({ error: String(e && e.stack) })); app.exit(5); }
    });
  });
  setTimeout(() => process.exit(7), 30000);
} else {
  const R = { requests: [], saveDialogs: [], opened: [], external: [], errorBoxes: [], pdfNet: [], secondInstanceEvents: 0, messageBoxes: [] };
  dialog.showSaveDialog = async (a, b) => {
    const opts = b || a;
    R.saveDialogs.push({ defaultPath: opts.defaultPath, filters: opts.filters });
    return { canceled: false, filePath: path.join(OUT, 'docs', path.basename(opts.defaultPath)) };
  };
  dialog.showErrorBox = (t, m) => R.errorBoxes.push(`${t}: ${m}`);
  // The crash / hang dialogs: recorded, answered by messageBoxReply (which may also show the real one).
  const realShowMessageBox = dialog.showMessageBox;
  let messageBoxReply = () => ({ response: 0 });
  dialog.showMessageBox = async (a, b) => {
    const opts = b || a;
    R.messageBoxes.push({ type: opts.type, message: opts.message, buttons: opts.buttons, signal: !!opts.signal });
    return messageBoxReply(opts, b ? a : null);
  };
  shell.openPath = async (p) => { R.opened.push(p); return ''; };
  shell.openExternal = async (u) => { R.external.push(u); };
  app.on('second-instance', () => { R.secondInstanceEvents++; });

  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  app.whenReady().then(() => {
    protocol.handle('https', async (req) => {
      const u = new URL(req.url);
      const body = req.method === 'POST' ? await req.text() : '';
      R.requests.push({ host: u.host, path: u.pathname, method: req.method, apiKey: req.headers.get('x-api-key'), auth: !!req.headers.get('authorization'), authorization: u.host === 'api.anthropic.com' ? req.headers.get('authorization') : undefined, cookie: req.headers.get('cookie') });
      if (u.host === 'driver-vehicle-licensing.api.gov.uk') {
        const vrm = JSON.parse(body).registrationNumber;
        if (vrm === 'BL0CK3D') return new Response('<html><title>Access Denied</title><body>Blocked by web filter</body></html>', { status: 403, headers: { 'content-type': 'text/html' } });
        if (vrm === 'REDIR1') return new Response('', { status: 302, headers: { location: 'https://captive.example/login' } });
        if (vrm === 'HANG1') return new Promise(() => {});
        return json({ registrationNumber: vrm, make: 'FORD', colour: 'BLUE', fuelType: 'PETROL', engineCapacity: 998, yearOfFirstRegistration: 2015, monthOfFirstRegistration: 3, motStatus: 'Valid', motExpiry: '2027-03-01', taxStatus: 'Taxed' });
      }
      if (u.host === 'login.microsoftonline.com') return json({ access_token: 'T-' + Date.now(), expires_in: 3600, token_type: 'Bearer' });
      if (u.host === 'history.mot.api.gov.uk') {
        return json({ registration: 'AB12CDE', make: 'FORD', model: 'FOCUS', motTests: [{ completedDate: '2024-01-02T10:00:00.000Z', testResult: 'FAILED', odometerValue: '61200', odometerUnit: 'MI', odometerResultType: 'READ', defects: [{ type: 'DANGEROUS', dangerous: true, text: 'Brake hose ruptured' }, { type: 'MAJOR', dangerous: true, text: 'Brake pipe corroded' }] }] });
      }
      if (u.host === 'api.anthropic.com' && /\/v1\/messages$/.test(u.pathname)) {
        const reqBody = JSON.parse(body);
        return new Response(JSON.stringify({ id: 'msg_e2e', type: 'message', role: 'assistant', model: reqBody.model, content: [{ type: 'text', text: 'ready' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_e2e' } });
      }
      return new Response('not mocked', { status: 404 });
    });
    const ps = session.fromPartition('ers-pdf-export'); // observe (not filter) what the hidden PDF window loads
    ps.webRequest.onCompleted((d) => R.pdfNet.push({ ok: true, url: d.url }));
    ps.webRequest.onErrorOccurred((d) => R.pdfNet.push({ ok: false, error: d.error, url: d.url }));
  });

  require(path.join(ROOT, 'main.js'));

  let mainWin = null;
  app.on('browser-window-created', (_e, win) => {
    if (mainWin) return;
    mainWin = win;
    win.webContents.once('did-finish-load', () => setTimeout(() => run(win).catch((e) => { console.log('E2E HARNESS ERROR', e && e.stack); app.exit(2); }), 800));
  });

  const results = [];
  const check = (name, cond, detail) => { results.push({ name, ok: !!cond, detail }); };
  const text = (v) => JSON.stringify(v);
  const isA4 = (box) => { const n = (String(box).match(/[\d.]+/g) || []).map(Number); return n.length === 4 && Math.abs(n[2] - n[0] - 595.28) < 1.5 && Math.abs(n[3] - n[1] - 841.89) < 1.5; };

  async function run(win) {
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const appUrl = win.webContents.getURL();
    check('App page loaded from app/index.html', /^file:\/\/.*\/app\/index\.html(#.*)?$/i.test(appUrl), appUrl);
    const bridge = await js('typeof window.desktop === "object" ? Object.keys(window.desktop).sort().join(",") : ""');
    check('Desktop bridge exposed on the app page', bridge === 'ai,app,backup,data,exportPdf,saveFile', bridge);
    const booted = await js('!!(window.Core && window.Report && window.Sample && document.querySelector("#app, main, body"))');
    check('App scripts loaded (Core, Report, Sample)', booted, booted);

    const aiStatus = await js('desktop.ai.status()');
    check('ai:status answers with no key saved', aiStatus.ok === true && aiStatus.hasKey === !!process.env.ANTHROPIC_API_KEY, text(aiStatus));
    const ds0 = await js('desktop.data.status()');
    check('data:status answers with no credentials saved', ds0.ok === true && ds0.dvla === false && ds0.mot === false, text(ds0));

    const attacker = await js(`desktop.data.setKeys({ motClientId: 'cid', motClientSecret: 'TOP-SECRET-VALUE', motApiKey: 'k', motTokenUrl: 'https://attacker.example/collect' })`);
    check('Look-alike token URL refused, secret not echoed', attacker.ok === false && !text(attacker).includes('TOP-SECRET-VALUE'), text(attacker));
    const setKeys = await js(`desktop.data.setKeys({ dvla: ' DVLA-TEST-KEY\\u200b ', motClientId: 'cid', motClientSecret: 'secret-e2e', motApiKey: 'apikey-e2e', motTenantId: '1a2b3c4d-1111-2222-3333-444455556666' })`);
    check('DVLA and MOT credentials saved', setKeys.ok === true, text(setKeys));
    const ds1 = await js('desktop.data.status()');
    check('data:status reports both connections configured', ds1.ok === true && ds1.dvla === true && ds1.mot === true, text(ds1));
    if (process.platform === 'win32') check('Credentials encrypted with Windows data protection (DPAPI)', ds1.encrypted === true && ds1.protection === 'os', text(ds1));
    const keyFile = fs.readFileSync(path.join(OUT, 'userData', 'data-keys.bin'));
    check('Key file contains no plain-text secret', !keyFile.toString('latin1').includes('secret-e2e') || ds1.protection === 'none', `protection=${ds1.protection}`);

    const dvla = await js(`desktop.data.dvla('ab12 cde', 'live')`);
    check('DVLA lookup through net.fetch returns the vehicle', dvla.ok === true && dvla.result && dvla.result.make === 'FORD' && dvla.result.firstRegistration === '2015-03-01', text(dvla));
    const dvlaReq = R.requests.find((r) => r.host === 'driver-vehicle-licensing.api.gov.uk');
    check('DVLA request: cleaned key in x-api-key, no cookie', dvlaReq && dvlaReq.apiKey === 'DVLA-TEST-KEY' && !dvlaReq.cookie, text(dvlaReq));
    const blocked = await js(`desktop.data.dvla('BL0CK3D', 'live')`);
    check('HTML 403 explained as a proxy/firewall block, no raw HTML', blocked.ok === false && /proxy|firewall/i.test(blocked.error) && !/<html/i.test(blocked.error), text(blocked));
    const redirect = await js(`desktop.data.dvla('REDIR1', 'live')`);
    check('Redirect refused (keys never follow a redirect)', redirect.ok === false && /redirect/i.test(redirect.error) && !R.requests.some((r) => r.host === 'captive.example'), text(redirect));
    const t0 = Date.now();
    const hang = await js(`desktop.data.dvla('HANG1', 'live')`);
    const hangMs = Date.now() - t0;
    check('Unanswered request times out with a clear message', hang.ok === false && /did not respond|timed? ?out/i.test(hang.error) && hangMs < 45000, `${hangMs} ms ${text(hang)}`);

    const mot = await js(`desktop.data.mot('AB12CDE', 'registration')`);
    const motTests = (mot.result && mot.result.tests) || [];
    check('MOT History lookup (OAuth token + API key) returns tests', mot.ok === true && motTests.length === 1 && motTests[0].odometer === 61200, text(mot).slice(0, 400));
    check('Dangerous defects labelled once', /DANGEROUS: Brake hose ruptured/.test(text(mot)) && /MAJOR \(DANGEROUS\): Brake pipe corroded/.test(text(mot)) && !/DANGEROUS \(DANGEROUS\)/.test(text(mot)), text(motTests[0] && motTests[0].defects));
    const motReq = R.requests.find((r) => r.host === 'history.mot.api.gov.uk');
    check('MOT request carries Bearer token and API key', motReq && motReq.auth && motReq.apiKey === 'apikey-e2e', text(motReq));

    const aiSet = await js(`desktop.ai.setKey(' sk-ant-api03-E2ETESTKEY\\u200b ')`);
    const aiStatus2 = await js('desktop.ai.status()');
    check('Anthropic key saved', aiSet.ok === true && aiStatus2.hasKey === true, text(aiStatus2));
    const aiTest = await js(`desktop.ai.test({ model: 'claude-opus-5-5' })`);
    const aiReq = R.requests.find((r) => r.host === 'api.anthropic.com');
    check('AI connection test runs through the SDK and net.fetch', aiTest.ok === true && aiReq && (aiReq.apiKey === 'sk-ant-api03-E2ETESTKEY' || aiReq.authorization === 'Bearer sk-ant-api03-E2ETESTKEY'), `${text(aiTest)} ${text(aiReq && { host: aiReq.host, path: aiReq.path, keySent: !!(aiReq.apiKey || aiReq.authorization) })}`);

    const notif = await js('Notification.requestPermission()');
    const camera = await js('navigator.mediaDevices.getUserMedia({ video: true }).then(() => "granted", (e) => e.name)');
    check('Permission requests denied (notifications, camera)', notif === 'denied' && camera !== 'granted', `${notif} / ${camera}`);

    const save = await js(`desktop.saveFile({ content: '{"a":1}', fileName: '..\\\\..\\\\Startup\\\\update.bat', filters: [{ name: 'Batch', extensions: ['bat'] }] })`);
    check('Save dialog: base name only, forced .json', save.ok === true && /\.json$/i.test(save.filePath) && !/\.\.|Startup[\\/]/i.test(save.filePath) && fs.existsSync(save.filePath), text(save));

    const info = await js('desktop.app.info()');
    check('app.info returns the data folder (userData)', info.ok === true && typeof info.dataFolder === 'string' && path.resolve(info.dataFolder) === path.resolve(OUT, 'userData'), text(info));

    // ---- streaming backup through window.desktop.backup: real IPC, real files ----
    const docsDir = path.join(OUT, 'docs');
    const partFiles = () => fs.readdirSync(docsDir).filter((f) => f.endsWith('.part'));
    const bk = await js(`(async () => {
      const lines = [{ kind: 'engineer-report-studio-backup', format: 2, at: new Date().toISOString(), jobs: 1 }, { type: 'settings', data: { note: 'Müller – 🚗 “quoted”' } }, { type: 'customOem', data: [] },
        { type: 'job', data: { id: 'e2e-backup', photo: 'data:image/jpeg;base64,' + 'Q'.repeat(9 * 1024 * 1024), text: '€–🚙'.repeat(50000) } }, { type: 'end', jobs: 1 }];
      const all = lines.map((o) => JSON.stringify(o)).join('\\n') + '\\n';
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(all))), (x) => x.toString(16).padStart(2, '0')).join('');
      const b = await desktop.backup.begin({ fileName: 'backup-e2e.ersbackup' });
      if (!b.ok) return { b };
      const second = await desktop.backup.begin({ fileName: 'other' });
      const cut = all.indexOf('🚗') + 1; // inside the emoji's surrogate pair
      const writes = [];
      for (const piece of [all.slice(0, cut), all.slice(cut, 5e6), all.slice(5e6)]) writes.push(await desktop.backup.write(b.id, piece));
      const end = await desktop.backup.end(b.id);
      const after = await desktop.backup.write(b.id, 'x');
      return { b, second, writes, end, after, sha256 };
    })()`);
    const backupPath = path.join(docsDir, 'backup-e2e.ersbackup');
    const fileSha = fs.existsSync(backupPath) ? crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex') : '';
    const bkDialog = R.saveDialogs.find((x) => path.basename(String(x.defaultPath)) === 'backup-e2e.ersbackup');
    check('Backup: begin → 3 writes (one split inside an emoji) → end writes exactly the UTF-8 text', bk.end && bk.end.ok === true && bk.end.filePath === backupPath && fileSha === bk.sha256 && (bk.writes || []).every((w) => w.ok), `${text({ ...bk, sha256: undefined })} file=${fileSha} page=${bk.sha256}`);
    check('Backup: .ersbackup dialog, second begin refused, closed afterwards, nothing opened, no .part file left', bkDialog && text(bkDialog.filters) === text([{ name: 'Engineer Report Studio backup', extensions: ['ersbackup'] }]) && bk.second && bk.second.ok === false && /already being written/.test(bk.second.error) && bk.after && bk.after.ok === false && !R.opened.includes(backupPath) && partFiles().length === 0, `${text(bkDialog)} ${text(bk.second)} ${text(partFiles())}`);
    const ab1 = await js(`desktop.backup.begin({ fileName: 'aborted' }).then(async (b) => ({ b, w: b.ok ? await desktop.backup.write(b.id, 'partial data') : null }))`);
    const partsWhileOpen = partFiles();
    const ab2 = ab1.b && ab1.b.ok ? await js(`desktop.backup.abort(${JSON.stringify(ab1.b.id)})`) : null;
    check('Backup abort deletes the temporary file; the target is never created', ab1.w && ab1.w.ok && partsWhileOpen.length === 1 && /^aborted\.ersbackup\.[0-9a-f-]{36}\.part$/.test(partsWhileOpen[0]) && ab2 && ab2.ok && partFiles().length === 0 && !fs.existsSync(path.join(docsDir, 'aborted.ersbackup')), `${text(ab1)} ${text(partsWhileOpen)} ${text(ab2)}`);
    const t1 = Date.now();
    const lim = await js(`(async () => {
      const b = await desktop.backup.begin({ fileName: 'limit' });
      const max = await desktop.backup.write(b.id, '\\u2013'.repeat(64 * 1024 * 1024)); // the largest piece, all two-byte characters: 128 MB over IPC
      const over = await desktop.backup.write(b.id, 'a'.repeat(64 * 1024 * 1024 + 1));
      const end = await desktop.backup.end(b.id);
      const abort = await desktop.backup.abort(b.id);
      const unknown = await desktop.backup.write('no-such-id', 'x');
      return { b, max, over, end, abort, unknown };
    })()`);
    check('Backup limit over real IPC: a 64 Mi-character piece (128 MB) is accepted; one character more stops the backup and deletes it; unknown id refused', lim.max && lim.max.ok === true && lim.over.ok === false && /64 MiB/.test(lim.over.error) && lim.end.ok === false && lim.abort.ok === true && lim.unknown.ok === false && partFiles().length === 0 && !fs.existsSync(path.join(docsDir, 'limit.ersbackup')), `${Date.now() - t1} ms ${text(lim)}`);

    const pdf = await js(`(async () => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d');
      g.fillStyle = '#2d6fb5'; g.fillRect(0, 0, 640, 480); g.fillStyle = '#fff'; g.font = 'bold 60px sans-serif'; g.fillText('TEST PHOTO', 120, 260);
      const j = Sample.sampleJob();
      j.photos = [{ id: 'p1', dataUrl: c.toDataURL('image/jpeg', 0.9), w: 640, h: 480, title: 'Front', caption: 'Test', source: 'Test', labels: [], takenAt: new Date().toISOString() }];
      const html = Report.render(j, { mode: 'pdf' }); const tpl = Report.pdfTemplates(j);
      return desktop.exportPdf({ html, header: tpl.header, footer: tpl.footer, fileName: 'Sample report AB14 CDE' });
    })()`);
    let pdfInfo = null;
    if (pdf && pdf.ok && fs.existsSync(pdf.filePath)) {
      const s = fs.readFileSync(pdf.filePath).toString('latin1');
      pdfInfo = { bytes: s.length, magic: s.slice(0, 5), pages: (s.match(/\/Type\s*\/Page[^s]/g) || []).length, mediaBox: (s.match(/\/MediaBox\s*\[[^\]]*\]/) || [''])[0], images: (s.match(/\/Subtype\s*\/Image/g) || []).length };
    }
    check('PDF export: valid multi-page A4 PDF with the photo', pdfInfo && pdfInfo.magic === '%PDF-' && pdfInfo.pages >= 6 && isA4(pdfInfo.mediaBox) && pdfInfo.images >= 1, `${text(pdf)} ${text(pdfInfo)}`);
    check('PDF export opens the saved file', pdf && R.opened.includes(pdf.filePath), text(R.opened));

    const hostile = await js(`desktop.exportPdf({ html: '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://example.invalid/"></head><body><p>hostile</p><img src="https://tracker.example/p.gif"><img src="file:///C:/Windows/win.ini"><img src="file:///etc/hostname"></body></html>', header: '', footer: '', fileName: 'hostile' })`);
    const pdfLoads = R.pdfNet.filter((n) => n.ok).map((n) => n.url);
    check('Hostile report HTML: no web or other local file loaded by the PDF window', hostile.ok === true && pdfLoads.every((u) => /^data:/.test(u) || /ers-report-[0-9a-f-]+\.html$/i.test(u)) && !R.requests.some((r) => /tracker\.example|example\.invalid/.test(r.host)), text(pdfLoads.map((u) => u.slice(0, 80))));

    const local = path.join(OUT, 'claim-pack.html');
    fs.writeFileSync(local, '<p>evil</p>');
    await js(`location.href = ${JSON.stringify(pathToFileURL(local).href)}; 1`);
    await new Promise((r) => setTimeout(r, 800));
    check('Navigation to another local page blocked', win.webContents.getURL() === appUrl, win.webContents.getURL());
    await js(`window.open('https://example.org/advert', '_blank'); window.open('file:///C:/Windows/System32/calc.exe'); 1`);
    await new Promise((r) => setTimeout(r, 400));
    check('window.open: web link to the system browser, file link refused, no new window', BrowserWindow.getAllWindows().length === 1 && text(R.external) === text(['https://example.org/advert']), text(R.external));

    const runChild = (arg, out, ms) => new Promise((res) => {
      const p = spawn(process.execPath, childArgs(arg), { stdio: 'ignore', env: { ...process.env, ERS_E2E_OUT: out } });
      const t = setTimeout(() => { p.kill(); res('timeout'); }, ms);
      p.on('exit', (code) => { clearTimeout(t); res(code); });
    });
    const secondExit = await runChild('--second-instance', OUT, 25000);
    await new Promise((r) => setTimeout(r, 500));
    check('Second launch quits and focuses the running window', secondExit === 0 && R.secondInstanceEvents === 1, `exit=${secondExit} events=${R.secondInstanceEvents}`);

    // closing the window, or quitting, while a backup is being written: the app still quits, and the .part file is gone
    for (const mode of ['close', 'quit']) {
      const dir = path.join(OUT, `quit-${mode}`);
      for (const d of ['userData', 'temp', 'docs']) fs.mkdirSync(path.join(dir, d), { recursive: true });
      const exit = await runChild(`--quit-during-backup=${mode}`, dir, 35000);
      let state = null;
      try { state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch (e) { state = { error: String(e) }; }
      const left = fs.readdirSync(path.join(dir, 'docs'));
      check(`${mode === 'close' ? 'Closing the window' : 'Quitting the app'} during a backup: the app quits and its temporary file is deleted`, exit === 0 && state.r && state.r.b.ok && state.r.w.ok && state.parts.length === 1 && left.length === 0, `exit=${exit} ${text(state)} left=${text(left)}`);
    }

    // ---- the page hanging or crashing: dialog, reload in a new renderer process, saved data read again ----
    const wc = win.webContents;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitUntil = async (cond, ms) => { for (let i = 0; i * 50 < ms && !cond(); i++) await sleep(50); return !!cond(); };
    const nextLoad = () => new Promise((res) => { const t = setTimeout(() => res(false), 20000); wc.once('did-finish-load', () => { clearTimeout(t); res(true); }); });
    const savedJob = await js(`Core.Store.saveJob(Object.assign(Sample.sampleJob(), { id: 'e2e-crash-job' })).then(() => true, (e) => String(e))`);
    const readJob = () => js(`Core.Store.getJob('e2e-crash-job').then((j) => (j && j.id) || null, (e) => String(e))`);
    // (a) hang → Reload: the hung renderer is ended and a new one loads the page; that kill is not reported as a crash
    const hangBackup = await js(`desktop.backup.begin({ fileName: 'hang' }).then(async (b) => { if (b.ok) await desktop.backup.write(b.id, 'partial'); return b; })`);
    const partsBeforeHang = partFiles().length;
    const pid0 = wc.getOSProcessId();
    R.messageBoxes.length = 0;
    messageBoxReply = () => ({ response: 1 }); // Reload
    let loaded = nextLoad();
    wc.emit('unresponsive');
    const hangReloaded = await loaded;
    await sleep(1000); // the killed renderer's render-process-gone has arrived by now
    const pidA = wc.getOSProcessId();
    const jobA = hangReloaded ? await readJob() : null;
    check('Hang → Reload: Wait / Reload / Close dialog; a new renderer process loads the page; the kill is not reported as a crash', savedJob === true && hangReloaded && pidA > 0 && pidA !== pid0 && R.messageBoxes.length === 1 && text(R.messageBoxes[0].buttons) === text(['Wait', 'Reload', 'Close']) && R.messageBoxes[0].signal, `saved=${savedJob} reloaded=${hangReloaded} pid ${pid0}→${pidA} ${text(R.messageBoxes)}`);
    check('After the reload the saved job is read from IndexedDB, and the backup of the hung page was deleted', jobA === 'e2e-crash-job' && hangBackup.ok && partsBeforeHang === 1 && partFiles().length === 0, `job=${jobA} backup=${text(hangBackup)} parts ${partsBeforeHang}→${text(partFiles())}`);
    // (b) a real "not responding" dialog closes by itself (AbortSignal) when the page responds again
    let realBox = null;
    messageBoxReply = (opts, parent) => { const p = realShowMessageBox.call(dialog, parent, opts); realBox = { closed: false }; p.then((v) => { realBox.closed = true; realBox.value = v; }, (e) => { realBox.closed = true; realBox.error = String(e); }); return p; };
    wc.emit('unresponsive');
    await sleep(800);
    const openUntilResponsive = !!realBox && !realBox.closed;
    wc.emit('responsive');
    const boxClosed = await waitUntil(() => realBox && realBox.closed, 8000);
    check('A real "not responding" dialog stays open until the page responds, then closes itself; within a minute of a restart it offers Wait / Close only', openUntilResponsive && boxClosed && !realBox.error && realBox.value && realBox.value.response === 0 && R.messageBoxes.length === 2 && text(R.messageBoxes[1].buttons) === text(['Wait', 'Close']) && wc.getOSProcessId() === pidA, `open=${openUntilResponsive} ${text(realBox)} ${text(R.messageBoxes[1])}`);
    // (c) a minute later: a renderer crash → Reload brings the page back with its data
    const realNow = Date.now;
    Date.now = () => realNow() + 61 * 1000;
    try {
      messageBoxReply = () => ({ response: 0 }); // Reload
      loaded = nextLoad();
      wc.forcefullyCrashRenderer();
      const crashReloaded = await loaded;
      const pidC = wc.getOSProcessId();
      const jobC = crashReloaded ? await readJob() : null;
      const crashBox = R.messageBoxes[2] || {};
      check('Renderer crash: error dialog Reload / Close; Reload brings the page back in a new process with its saved job', crashReloaded && crashBox.type === 'error' && text(crashBox.buttons) === text(['Reload', 'Close']) && pidC > 0 && pidC !== pidA && jobC === 'e2e-crash-job' && (await js('typeof desktop.backup.begin')) === 'function', `reloaded=${crashReloaded} pid ${pidA}→${pidC} job=${jobC} ${text(R.messageBoxes)}`);
      // (d) a second crash within a minute: Close only (left open here, so the window stays for the last checks)
      messageBoxReply = () => new Promise(() => {});
      wc.forcefullyCrashRenderer();
      const second = await waitUntil(() => R.messageBoxes.length === 4, 8000);
      check('A second crash within a minute offers Close only (no reload loop)', second && text(R.messageBoxes[3].buttons) === text(['Close']) && /again/.test(R.messageBoxes[3].message) && !win.isDestroyed(), text(R.messageBoxes));
    } finally { Date.now = realNow; }

    const tempLeft = fs.readdirSync(path.join(OUT, 'temp')).filter((f) => /^ers-report-/.test(f));
    check('PDF temp files deleted', tempLeft.length === 0, text(tempLeft));
    check('No backup temporary (.part) files left', partFiles().length === 0, text(partFiles()));
    check('No error boxes shown', R.errorBoxes.length === 0, text(R.errorBoxes));
    check('No request left the mock (every host expected)', R.requests.every((r) => ['driver-vehicle-licensing.api.gov.uk', 'login.microsoftonline.com', 'history.mot.api.gov.uk', 'api.anthropic.com'].includes(r.host)), text([...new Set(R.requests.map((r) => r.host))]));

    const failed = results.filter((r) => !r.ok);
    for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '\n    ' + String(r.detail).slice(0, 600)}`);
    console.log(failed.length ? `Electron end-to-end test FAILED: ${failed.length} of ${results.length} checks.` : `Electron end-to-end test passed: ${results.length} checks (Electron ${process.versions.electron}, ${process.platform}).`);
    try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* Windows may still hold a file */ }
    app.exit(failed.length ? 1 : 0);
  }
  setTimeout(() => { console.log('E2E TIMEOUT'); for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}`); app.exit(3); }, 180000);
}
