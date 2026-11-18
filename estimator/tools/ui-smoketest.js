#!/usr/bin/env node
/*
 * UI smoke test: serves app/ over HTTP, drives every screen and flow in Chromium (Playwright) with the
 * Electron bridge (window.desktop) mocked in preload.js's shape, and fails on any page/console error.
 * Run: node tools/ui-smoketest.js   (CI: after `npx playwright install --with-deps chromium`)
 */
'use strict';
require('./ui/smoke.js');
