// Keys of the page of the TV (public/js/display.js), in a vm context with
// doubles of jQuery, fetch and the frames: with a broadcaster application
// running, Escape goes to it as BrowserBack and ContextMenu as ContextMenu
// (ABNT NBR 25608, 10.6.3 and Table B.1); a Back it does not cancel, sent
// back by the bridge, and Home do what Escape does without an application.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const POPUP_JS = path.join(__dirname, '..', 'public', 'js', 'popup.js');
const DISPLAY_JS = path.join(__dirname, '..', 'public', 'js', 'display.js');
const APP_URL = 'http://ctx-0123456789abcdef.apps.localhost:8081/app.pkg/index.html';
const APP_ORIGIN = 'http://ctx-0123456789abcdef.apps.localhost:8081';
const KEYS = { Escape: 27, ContextMenu: 93, Home: 36, a: 65 };
const SCREEN_URL = 'http://componente.test:8090/tela';
const SCREEN_ORIGIN = 'http://componente.test:8090';

// screen: the screen of the interface layer, { src, document }; document
// null is a screen of another origin.
function page(graphicsSrc, screen = { src: '', document: null }) {
    const posted = [];
    const contentWindow = {
        postMessage: (message, origin) => {
            posted.push({ message, origin });
        },
    };
    const graphics = {
        src: graphicsSrc,
        contentWindow,
        contentDocument: null,
        getAttribute: (name) => (name === 'src' ? graphicsSrc : null),
    };
    const screenWindow = {
        postMessage: (message, origin) => {
            posted.push({ message, origin, frame: 'rxgui' });
        },
    };
    const rxgui = {
        src: screen.src,
        contentWindow: screenWindow,
        contentDocument: screen.document,
        getAttribute: (name) => (name === 'src' ? screen.src : null),
    };
    const elements = { graphics, rxgui, popup: { style: {} }, video: {} };
    const attrs = { '#graphics': graphicsSrc, '#rxgui': screen.src };
    const $ = (selector) => ({
        attr: () => attrs[selector] ?? '',
        length: 1,
        replaceWith() {},
        css() {},
    });
    const fetched = [];
    const listeners = {};
    const document = {
        getElementById: (id) => elements[id] || null,
        addEventListener: (type, handler) => {
            listeners[`document ${type}`] = handler;
        },
    };
    const client = { on() {}, subscribe() {}, publish() {} };
    const ctx = vm.createContext({
        $,
        document,
        URL,
        KeyboardEvent: class {
            constructor(type, init) {
                Object.assign(this, { type }, init);
            }
        },
        console,
        setTimeout,
        clearTimeout,
        crypto: globalThis.crypto,
        fetch: async (url) => {
            fetched.push(url);
            return { ok: true };
        },
        mqtt: { connect: () => client },
        location: { protocol: 'http:', host: 'tv.test', href: 'http://tv.test/' },
        addEventListener: (type, handler) => {
            listeners[`window ${type}`] = handler;
        },
    });
    ctx.window = ctx;
    vm.runInContext(fs.readFileSync(POPUP_JS, 'utf8'), ctx, { filename: 'popup.js' });
    vm.runInContext(fs.readFileSync(DISPLAY_JS, 'utf8'), ctx, { filename: 'display.js' });
    const press = (key) => {
        listeners['document keydown']({ key, keyCode: KEYS[key], preventDefault() {} });
    };
    const message = (data, origin, source = contentWindow) => {
        listeners['window message']({ data, origin, source });
    };
    return { press, message, posted, fetched, screenWindow };
}

test('com aplicacao: Escape vai como BrowserBack e ContextMenu como ContextMenu, so a origem dela', () => {
    const p = page(APP_URL);
    p.press('Escape');
    p.press('ContextMenu');
    p.press('a');
    assert.deepEqual(p.posted.map((m) => [m.message.key, m.origin]), [
        ['BrowserBack', APP_ORIGIN],
        ['ContextMenu', APP_ORIGIN],
        ['a', APP_ORIGIN],
    ]);
    assert.deepEqual(p.fetched, []);
});

test('Home e a funcao fixa: vai a plataforma mesmo com aplicacao', () => {
    const p = page(APP_URL);
    p.press('Home');
    assert.deepEqual(p.fetched, ['keydown/36']);
    assert.deepEqual(p.posted, []);
});

test('Back nao cancelado devolvido pela ponte faz o que o Escape faz sem aplicacao', () => {
    const p = page(APP_URL);
    p.message({ type: 'tv30-aop-back' }, APP_ORIGIN);
    assert.deepEqual(p.fetched, ['keydown/27']);
});

test('mensagem de outra origem ou de outra janela nao devolve o Back', () => {
    const p = page(APP_URL);
    p.message({ type: 'tv30-aop-back' }, 'http://outra.test');
    p.message({ type: 'tv30-aop-back' }, APP_ORIGIN, {});
    p.message({ type: 'outra' }, APP_ORIGIN);
    assert.deepEqual(p.fetched, []);
});

test('sem aplicacao: Escape e ContextMenu vao a plataforma', () => {
    const p = page('');
    p.press('Escape');
    p.press('ContextMenu');
    assert.deepEqual(p.fetched, ['keydown/27', 'keydown/93']);
    assert.deepEqual(p.posted, []);
});

// A screen of the platform: the document of the frame, of the same origin;
// cancel says whether its handler cancels the key.
function platformScreen(cancel) {
    const received = [];
    return {
        received,
        document: {
            dispatchEvent: (event) => {
                received.push(event.key);
                return !(cancel && event.cancelable);
            },
        },
    };
}

test('tela da plataforma na camada de interface: Escape vai como BrowserBack; nao cancelado, a plataforma faz o Escape', () => {
    const screen = platformScreen(false);
    const p = page('', { src: '/prfchs', document: screen.document });
    p.press('Escape');
    p.press('ContextMenu');
    p.press('a');
    assert.deepEqual(screen.received, ['BrowserBack', 'ContextMenu', 'a']);
    assert.deepEqual(p.fetched, ['keydown/27']);
});

test('tela da plataforma que cancela o Back: nada vai a plataforma', () => {
    const screen = platformScreen(true);
    const p = page('', { src: '/prfchs', document: screen.document });
    p.press('Escape');
    assert.deepEqual(screen.received, ['BrowserBack']);
    assert.deepEqual(p.fetched, []);
});

test('tela de componente de outra origem: as teclas vao por postMessage, so a origem dela; Home vai a plataforma', () => {
    const p = page('', { src: SCREEN_URL, document: null });
    p.press('Escape');
    p.press('a');
    p.press('Home');
    assert.deepEqual(p.posted.map((m) => [m.message.key, m.origin, m.frame]), [
        ['BrowserBack', SCREEN_ORIGIN, 'rxgui'],
        ['a', SCREEN_ORIGIN, 'rxgui'],
    ]);
    assert.deepEqual(p.fetched, ['keydown/36']);
});

test('Back nao cancelado pela tela de componente, devolvido pela ponte, vai a plataforma como Escape', () => {
    const p = page('', { src: SCREEN_URL, document: null });
    p.message({ type: 'tv30-aop-back' }, SCREEN_ORIGIN, p.screenWindow);
    p.message({ type: 'tv30-aop-back' }, 'http://outra.test', p.screenWindow);
    assert.deepEqual(p.fetched, ['keydown/27']);
});
