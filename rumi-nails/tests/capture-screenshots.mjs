import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profilePath = mkdtempSync(join(tmpdir(), 'rumi-nails-chrome-'));
const port = 9337;
const siteUrl = 'http://127.0.0.1:4173/';
const outputDir = new URL('./screenshots/', import.meta.url);
mkdirSync(outputDir, { recursive: true });

const viewports = [
  { label: '1440x900', width: 1440, height: 900 },
  { label: '1200x800', width: 1200, height: 800 },
  { label: '1024x768', width: 1024, height: 768 },
  { label: '768x1024', width: 768, height: 1024 },
  { label: '430x932', width: 430, height: 932, mobile: true },
  { label: '390x844', width: 390, height: 844, mobile: true },
  { label: '375x812', width: 375, height: 812, mobile: true }
];

const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profilePath}`,
  'about:blank'
], { stdio: 'ignore', windowsHide: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForChrome() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error('Chrome DevTools did not start in time.');
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
        return;
      }
      const listeners = this.events.get(message.method) || [];
      listeners.splice(0).forEach((resolve) => resolve(message.params));
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const listeners = this.events.get(method) || [];
      listeners.push(resolve);
      this.events.set(method, listeners);
    });
  }

  close() { this.socket.close(); }
}

try {
  await waitForChrome();
  const createResponse = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const target = await createResponse.json();
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const results = [];
  for (const viewport of viewports) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      // A desktop layout viewport at the requested width avoids Chromium's
      // 21 px mobile visual-viewport offset while still exercising CSS breakpoints.
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height
    });
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: siteUrl });
    await loaded;
    await cdp.send('Runtime.evaluate', {
      expression: 'document.fonts.ready',
      awaitPromise: true,
      returnByValue: true
    });
    await wait(1300);

    const metricsResponse = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        innerWidth,
        innerHeight,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        h1Visible: getComputedStyle(document.querySelector('h1')).opacity,
        menuVisible: getComputedStyle(document.querySelector('.menu-toggle')).display !== 'none'
      })`,
      returnByValue: true
    });
    const metrics = JSON.parse(metricsResponse.result.value);
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 82,
      captureBeyondViewport: false,
      fromSurface: true
    });
    const fileName = `${viewport.mobile ? 'mobile' : 'viewport'}-${viewport.label}.jpg`;
    writeFileSync(new URL(fileName, outputDir), Buffer.from(screenshot.data, 'base64'));
    results.push({ viewport: viewport.label, fileName, metrics });
  }

  writeFileSync(new URL('viewport-results.json', import.meta.url), JSON.stringify(results, null, 2));
  cdp.close();
  console.log(JSON.stringify(results, null, 2));
} finally {
  chrome.kill();
  await wait(200);
  rmSync(profilePath, { recursive: true, force: true });
}
