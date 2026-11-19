// aop-dash-streams (the MPD of the current service, with the base of the
// segment URLs resolved, and its route) and the choice of the media of the
// Bootstrap Application: initialMediaURL, the MPD of the SLS, or
// fallbackMediaURLs; HLS only in the Broadband configuration.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const express = require('express');

const realError = console.error;
const logs = [];
console.error = (...a) => { logs.push(a.join(' ')); };
after(() => { console.error = realError; });

// --- double of the core ------------------------------------------------------
const played = [];
let entry;
const coreFile = require.resolve('../src/core');
const fakeCore = {
    GUI: { bootstrap_app: '/btpapp' },
    getCurrentService: () => entry,
    setVideoURL: (url = '') => played.push(url),
    setVideoSize() {},
};
const m = new Module(coreFile);
m.filename = coreFile;
m.loaded = true;
m.exports = fakeCore;
require.cache[coreFile] = m;

const dash = require('../src/modules/dash-streams');
const bootstrap = require('../src/modules/bootstrap-application/service');

const LIVE = 'http://localhost:8082/live/';
const HLS = `${LIVE}video/master.m3u8`;
const mpdOf = (base, adaptationBase = 'video/') => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minimumUpdatePeriod="PT4S">
  <BaseURL>${base}</BaseURL>
  <Period id="0" start="PT0S">
    <AdaptationSet id="1"><BaseURL>${adaptationBase}</BaseURL></AdaptationSet>
  </Period>
</MPD>`;

function reset(configuration = 'Broadband', bam = {}) {
    played.length = 0;
    logs.length = 0;
    entry = { serviceContextId: 'urn:s:1001', serviceId: 1001, bsid: 10, configuration, bam };
    dash.select(1001);
}

// --- aop-dash-streams --------------------------------------------------------
test('Broadband: a MPD com MPD.BaseURL absoluto e servida; BaseURL sem / final ganha a /', () => {
    reset();
    assert.equal(dash.mediaUrl(1001), undefined);
    dash.receive('1001', mpdOf('http://localhost:8082/live', 'video'));
    assert.equal(dash.mediaUrl(1001), '/dash/1001/mpd');
    const served = require('../src/modules/dash-streams/service').mpd('1001');
    assert.match(served, /<BaseURL>http:\/\/localhost:8082\/live\/<\/BaseURL>/);
    assert.match(served, /<BaseURL>video\/<\/BaseURL>/);
});

test('MPD.BaseURL relativo: vai depois da base da comporta do servico, por concatenacao (5.4); ausente: recusada, com log', () => {
    reset('Broadcast');
    dash.receive('1001', mpdOf('/live/'));
    assert.equal(dash.mediaUrl(1001), '/dash/1001/mpd');
    const served = require('../src/modules/dash-streams/service').mpd('1001');
    assert.match(served, /<BaseURL>http:\/\/apps\.localhost:8081\/svc\/1001\/live\/<\/BaseURL>/);
    assert.match(served, /<BaseURL>video\/<\/BaseURL>/);

    dash.receive('1001', '<MPD><Period/></MPD>');
    dash.receive('1001', '<MPD><Period/></MPD>');
    assert.equal(dash.mediaUrl(1001), undefined);
    assert.equal(logs.filter((l) => l.includes('no MPD.BaseURL')).length, 1);
});

test('so a MPD do servico corrente; mensagem vazia a tira; clear esquece o servico', () => {
    reset();
    dash.receive('2001', mpdOf(LIVE));
    assert.equal(dash.mediaUrl(2001), undefined);
    dash.receive('1001', mpdOf(LIVE));
    assert.equal(dash.mediaUrl(1001), '/dash/1001/mpd');
    dash.receive('1001', '');
    assert.equal(dash.mediaUrl(1001), undefined);
    dash.receive('1001', mpdOf(LIVE));
    dash.clear();
    assert.equal(dash.mediaUrl(1001), undefined);
});

test('GET /dash/<serviceId>/mpd: a MPD em application/dash+xml, sem cache; sem MPD, 404', async () => {
    reset();
    const app = express();
    app.use(dash.ROUTE, dash.router);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.equal((await fetch(`${base}/dash/1001/mpd`)).status, 404);
        dash.receive('1001', mpdOf(LIVE));
        const response = await fetch(`${base}/dash/1001/mpd`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /^application\/dash\+xml/);
        assert.equal(response.headers.get('cache-control'), 'no-cache');
        assert.match(await response.text(), /<MPD /);
        assert.equal((await fetch(`${base}/dash/2001/mpd`)).status, 404);
    } finally {
        await new Promise((r) => server.close(r));
    }
});

// --- media of the Bootstrap Application ---------------------------------------
test('initialMediaURL: URL HTTP absoluta de MPD ou M3U8; o resto e erro', () => {
    assert.equal(bootstrap.initialMediaParameter(undefined), undefined);
    assert.equal(bootstrap.initialMediaParameter(HLS), HLS);
    assert.equal(bootstrap.initialMediaParameter('https://x.test/a/b.mpd?t=1'), 'https://x.test/a/b.mpd?t=1');
    assert.throws(() => bootstrap.initialMediaParameter([HLS, HLS]), /more than once/);
    assert.throws(() => bootstrap.initialMediaParameter('video/master.m3u8'), /absolute/);
    assert.throws(() => bootstrap.initialMediaParameter('ftp://x.test/a.mpd'), /not HTTP/);
    assert.throws(() => bootstrap.initialMediaParameter('http://x.test/a.mp4'), /neither/);
});

test('sem parametro, a MPD do servico; com initialMediaURL, ele; no modo info, nada', () => {
    reset('Broadband', { fallbackMediaURLs: [HLS] });
    dash.receive('1001', mpdOf(LIVE));
    bootstrap.openBootstrapApp(undefined, undefined);
    assert.deepEqual(played, ['/dash/1001/mpd']);
    bootstrap.openBootstrapApp(undefined, HLS);
    assert.deepEqual(played, ['/dash/1001/mpd', HLS]);
    bootstrap.openBootstrapApp('info', HLS);
    assert.equal(played.length, 2);
});

test('sem MPD, o primeiro fallbackMediaURLs; a MPD que chega depois toma o lugar dele', () => {
    reset('Broadband', { fallbackMediaURLs: [HLS, 'http://x.test/b.m3u8'] });
    bootstrap.openBootstrapApp(undefined, undefined);
    assert.deepEqual(played, [HLS]);
    dash.receive('1001', mpdOf(LIVE));
    dash.receive('1001', mpdOf(LIVE));
    assert.deepEqual(played, [HLS, '/dash/1001/mpd']);
});

test('HLS so na configuracao Broadband: no Broadcast, recusado com log', () => {
    reset('Broadcast', { fallbackMediaURLs: [HLS] });
    bootstrap.openBootstrapApp(undefined, undefined);
    bootstrap.openBootstrapApp(undefined, HLS);
    assert.deepEqual(played, []);
    assert.equal(logs.filter((l) => l.includes('HLS refused')).length, 2);
    bootstrap.openBootstrapApp(undefined, 'http://x.test/a.mpd');
    assert.deepEqual(played, ['http://x.test/a.mpd']);
});

test('as rotas de lancamento: /btpapp recusa initialMediaURL fora da forma; /appcat/select o repassa', async () => {
    const displayed = [];
    fakeCore.setDisplayGui = (gui) => displayed.push(gui);
    fakeCore.setCurrentService = async () => undefined;
    const catalogFile = require.resolve('../src/modules/application-catalog/catalog');
    const c = new Module(catalogFile);
    c.filename = catalogFile;
    c.loaded = true;
    c.exports = {};
    require.cache[catalogFile] = c;
    const app = express();
    app.use('/btpapp', require('../src/modules/bootstrap-application'));
    app.use('/appcat', require('../src/modules/application-catalog'));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const refused = await fetch(`${base}/btpapp?initialMediaURL=${encodeURIComponent('http://x.test/a.mp4')}`);
        assert.equal(refused.status, 400);
        assert.match(refused.headers.get('content-type'), /^text\/plain/);

        const select = await fetch(`${base}/appcat/select?id=urn%3As%3A1001&initialMediaURL=${encodeURIComponent(HLS)}`);
        assert.equal(select.status, 200);
        assert.deepEqual(displayed, [`/btpapp?initialMediaURL=${encodeURIComponent(HLS)}`]);
        await fetch(`${base}/appcat/select?id=urn%3As%3A1001`);
        assert.deepEqual(displayed.at(-1), '/btpapp');
        const twice = await fetch(`${base}/appcat/select?id=x&initialMediaURL=a&initialMediaURL=b`);
        assert.equal(twice.status, 400);
    } finally {
        await new Promise((r) => server.close(r));
    }
});

