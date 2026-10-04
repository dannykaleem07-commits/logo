// ClaimDesk.exe entry point (embedded in the executable as a Node single-executable application).
// It only finds the app folder next to the executable and hands over to app/launch.cjs, so the launcher
// logic stays a normal file on disk that can be read, fixed and tested.
'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');
const appDir = path.join(path.dirname(process.execPath), 'app');
const launcher = path.join(appDir, 'launch.cjs');
try {
  createRequire(launcher)(launcher);
} catch (err) {
  console.error('ClaimDesk could not start: the "app" folder must sit next to ClaimDesk.exe.');
  console.error(String(err && err.stack ? err.stack : err));
  console.error('\nPress Enter to close this window.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}
