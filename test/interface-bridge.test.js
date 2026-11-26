// The bridge a screen of a component includes (public/js/interface-bridge.js),
// in a vm context: the key from the platform is dispatched on the focused
// element; a BrowserBack no handler cancels goes back to the platform.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BRIDGE_JS = path.join(__dirname, '..', 'public', 'js', 'interface-bridge.js');
const PLATFORM_ORIGIN = 'http://tv.test';

function screen(cancel) {
    const dispatched = [];
    const sentToPlatform = [];
    const listeners = {};
    const focused = {
        dispatchEvent: (event) => {
            dispatched.push(event.key);
            return !(cancel && event.cancelable);
        },
    };
    const parent = {
        postMessage: (message, origin) => {
            sentToPlatform.push({ message, origin });
        },
    };
    const ctx = vm.createContext({
        document: { activeElement: focused },
        KeyboardEvent: class {
            constructor(type, init) {
                Object.assign(this, { type }, init);
            }
        },
        addEventListener: (type, handler) => {
            listeners[type] = handler;
        },
    });
    ctx.window = ctx;
    ctx.window.parent = parent;
    vm.runInContext(fs.readFileSync(BRIDGE_JS, 'utf8'), ctx, { filename: 'interface-bridge.js' });
    const send = (data, source = parent) => {
        listeners.message({ data, origin: PLATFORM_ORIGIN, source });
    };
    return { send, dispatched, sentToPlatform };
}

test('ponte da camada de interface: a tecla vai ao elemento em foco; Back nao cancelado volta a plataforma', () => {
    const s = screen(false);
    s.send({ type: 'tv30-aop-event', event: 'keydown', key: 'a' });
    s.send({ type: 'tv30-aop-event', event: 'keydown', key: 'BrowserBack' });
    assert.deepEqual(s.dispatched, ['a', 'BrowserBack']);
    // The message is an object of the vm context: compared as JSON.
    assert.equal(JSON.stringify(s.sentToPlatform), JSON.stringify([{ message: { type: 'tv30-aop-back' }, origin: PLATFORM_ORIGIN }]));
});

test('ponte da camada de interface: Back cancelado fica na tela; mensagem de outra janela ou de outro tipo e ignorada', () => {
    const s = screen(true);
    s.send({ type: 'tv30-aop-event', event: 'keydown', key: 'BrowserBack' });
    s.send({ type: 'tv30-aop-event', event: 'keydown', key: 'a' }, {});
    s.send({ type: 'outra', event: 'keydown', key: 'a' });
    assert.deepEqual(s.dispatched, ['BrowserBack']);
    assert.deepEqual(s.sentToPlatform, []);
});
