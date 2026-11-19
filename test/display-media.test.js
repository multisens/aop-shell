// Media source of the page of the TV (public/js/display.js), in a vm context
// with doubles of jQuery, video.js and fetch: HLS goes to the player only
// with #EXT-X-MAP in every media playlist (ABNT NBR 25602, Annex C); a new
// source replaces the one of the player already created.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const POPUP_JS = path.join(__dirname, '..', 'public', 'js', 'popup.js');
const DISPLAY_JS = path.join(__dirname, '..', 'public', 'js', 'display.js');
const LIVE = 'http://localhost:8082/live/';
const MASTER = `${LIVE}video/master.m3u8`;
const MASTER_TEXT = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="../audio/playlist.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1118517,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"
playlist.m3u8
`;
const FMP4_TEXT = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000,\nseg/1.m4s\n';
const TS_TEXT = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1.001,\nseg-1.ts\n';

function page(files) {
    const popup = { html: '', visible: false };
    const popupEl = {
        html(s) {
            if (s === undefined) {
                return popup.html;
            }
            popup.html = s;
            return popupEl;
        },
        height() { return popupEl; },
        show() { popup.visible = true; return popupEl; },
        hide() { popup.visible = false; return popupEl; },
    };
    const video = { length: 1, replaceWith() {}, attr() {}, css() {} };
    const $ = (selector) => (selector === '#popup' ? popupEl : video);

    const players = [];
    function videojs() {
        const player = {
            sources: [],
            src(source) { player.sources.push(source); },
            play: () => Promise.resolve(),
            on() {},
            isDisposed: () => false,
            dispose() { player.disposed = true; },
            currentSource: () => player.sources.at(-1),
        };
        players.push(player);
        return player;
    }
    const fetched = [];
    const fetch = async (url) => {
        fetched.push(url);
        if (!(url in files)) {
            return { ok: false, status: 404 };
        }
        const text = files[url];
        return { ok: true, status: 200, text: async () => text };
    };
    const errors = [];
    const console = { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) };
    const document = {
        getElementById: (id) => ({ popup: { style: {} }, video: {}, graphics: {} }[id] || null),
        addEventListener() {},
    };
    const client = { on() {}, subscribe() {}, publish() {} };
    const ctx = vm.createContext({
        $, videojs, fetch, console, document, URL, setTimeout, clearTimeout,
        setInterval() {}, mqtt: { connect: () => client }, location: { protocol: 'http:', host: 'tv.test' },
    });
    ctx.window = ctx;
    vm.runInContext(fs.readFileSync(POPUP_JS, 'utf8'), ctx, { filename: 'popup.js' });
    vm.runInContext(fs.readFileSync(DISPLAY_JS, 'utf8'), ctx, { filename: 'display.js' });
    const setVideoUrl = (url) => vm.runInContext('setVideoUrl', ctx)(url);
    return { setVideoUrl, players, fetched, errors, popup };
}

test('HLS em fMP4: a mestre e as de midia tem #EXT-X-MAP, e a mestre vai ao reprodutor', async () => {
    const p = page({ [MASTER]: MASTER_TEXT, [`${LIVE}video/playlist.m3u8`]: FMP4_TEXT, [`${LIVE}audio/playlist.m3u8`]: FMP4_TEXT });
    await p.setVideoUrl(MASTER);
    assert.deepEqual(p.fetched, [MASTER, `${LIVE}audio/playlist.m3u8`, `${LIVE}video/playlist.m3u8`]);
    assert.equal(p.players.length, 1);
    assert.deepEqual(p.players[0].sources.map((s) => s.src), [MASTER]);
    assert.equal(p.popup.visible, false);
});

test('HLS com MPEG-2 TS (sem #EXT-X-MAP): recusado, com aviso na tela, sem reprodutor', async () => {
    const p = page({ [MASTER]: MASTER_TEXT, [`${LIVE}video/playlist.m3u8`]: TS_TEXT, [`${LIVE}audio/playlist.m3u8`]: FMP4_TEXT });
    await p.setVideoUrl(MASTER);
    assert.equal(p.players.length, 0);
    assert.equal(p.popup.visible, true);
    assert.match(p.popup.html, /Fluxo HLS recusado/);
    assert.ok(p.errors.some((e) => e.includes(`${LIVE}video/playlist.m3u8: sem #EXT-X-MAP`)), p.errors.join(' | '));
});

test('playlist de midia direta: so ela e lida; sem resposta, recusada', async () => {
    const media = `${LIVE}ts/playlist.m3u8`;
    const p = page({ [media]: TS_TEXT });
    await p.setVideoUrl(media);
    assert.deepEqual(p.fetched, [media]);
    assert.equal(p.players.length, 0);
    await p.setVideoUrl(`${LIVE}nada/master.m3u8`);
    assert.ok(p.errors.some((e) => e.includes('HTTP 404')));
    assert.equal(p.players.length, 0);
});

test('DASH vai direto; uma fonte nova troca a do reprodutor ja criado', async () => {
    const media = `${LIVE}video/playlist.m3u8`;
    const p = page({ [media]: FMP4_TEXT });
    await p.setVideoUrl('/dash/1001/mpd');
    assert.deepEqual(p.fetched, []);
    await p.setVideoUrl(media);
    assert.equal(p.players.length, 1);
    assert.deepEqual(p.players[0].sources.map((s) => s.type), ['application/dash+xml', 'application/x-mpegURL']);
});

test('fonte pedida durante a verificacao do HLS: a verificacao antiga nao inicia o reprodutor', async () => {
    const media = `${LIVE}video/playlist.m3u8`;
    const p = page({ [media]: FMP4_TEXT });
    const checking = p.setVideoUrl(media);
    await p.setVideoUrl('');
    await checking;
    assert.equal(p.players.length, 0);
});
