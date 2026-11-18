'use strict';
/*
 * End-to-end test of the real desktop app in real Electron: main.js + preload.js + vehicledata.js + ai.js + the app page.
 *
 *   Windows:  npx electron tools/electron-e2e.js
 *   Linux:    xvfb-run -a npx electron --no-sandbox tools/electron-e2e.js
 *
 * Nothing reaches DVLA, DVSA or Anthropic: every https request the app makes through net.fetch is answered by
 * protocol.handle('https') below. userData, temp and documents point into a fresh temporary folder; save dialogs and
 * shell are stubbed. The page is driven through the real preload bridge (window.desktop), so the main process's sender
 * checks see real frames. Exit code 0 means every check passed.
 */
const { app, BrowserWindow, dialog, shell, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SECOND = process.argv.includes('--second-instance');
const OUT = SECOND ? process.env.ERS_E2E_OUT : fs.mkdtempSync(path.join(os.tmpdir(), 'ers-e2e-'));
if (!OUT) { console.error('ERS_E2E_OUT not set'); process.exit(9); }
if (!SECOND) for (const d of ['userData', 'temp', 'docs']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
app.setPath('userData', path.join(OUT, 'userData'));
app.setPath('temp', path.join(OUT, 'temp'));
app.setPath('documents', path.join(OUT, 'docs'));

if (SECOND) {
  require(path.join(ROOT, 'main.js')); // must quit straight away: the first instance holds the single-instance lock
  setTimeout(() => process.exit(7), 20000);
} else {
  const R = { requests: [], saveDialogs: [], opened: [], external: [], errorBoxes: [], pdfNet: [], secondInstanceEvents: 0 };
  dialog.showSaveDialog = async (a, b) => {
    const opts = b || a;
    R.saveDialogs.push({ defaultPath: opts.defaultPath, filters: opts.filters });
    return { canceled: false, filePath: path.join(OUT, 'docs', path.basename(opts.defaultPath)) };
  };
  dialog.showErrorBox = (t, m) => R.errorBoxes.push(`${t}: ${m}`);
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
    check('Desktop bridge exposed on the app page', bridge === 'ai,data,exportPdf,saveFile', bridge);
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

    const secondExit = await new Promise((res) => {
      const args = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', __filename, '--second-instance'] : [__filename, '--second-instance'];
      const p = spawn(process.execPath, args, { stdio: 'ignore', env: { ...process.env, ERS_E2E_OUT: OUT } });
      const t = setTimeout(() => { p.kill(); res('timeout'); }, 25000);
      p.on('exit', (code) => { clearTimeout(t); res(code); });
    });
    await new Promise((r) => setTimeout(r, 500));
    check('Second launch quits and focuses the running window', secondExit === 0 && R.secondInstanceEvents === 1, `exit=${secondExit} events=${R.secondInstanceEvents}`);

    const tempLeft = fs.readdirSync(path.join(OUT, 'temp')).filter((f) => /^ers-report-/.test(f));
    check('PDF temp files deleted', tempLeft.length === 0, text(tempLeft));
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
