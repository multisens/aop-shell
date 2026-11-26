// Bridge of the platform for the screen of a component in the interface
// layer, served on another origin: the page includes it with
// <script src="http://<platform>/js/interface-bridge.js"></script>. The
// keys the platform sends by postMessage are dispatched on the focused
// element of the document; a BrowserBack that no handler cancels goes back
// to the platform.
(function () {
    const EVENT_TYPE = 'tv30-aop-event';
    const BACK_TYPE = 'tv30-aop-back';
    const BACK_KEY = 'BrowserBack';

    function dispatchKey(key, platformOrigin) {
        const target = document.activeElement || document;
        const event = new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true });
        const notCanceled = target.dispatchEvent(event);
        if (key === BACK_KEY && notCanceled) {
            window.parent.postMessage({ type: BACK_TYPE }, platformOrigin);
        }
    }

    function onMessage(e) {
        if (e.source !== window.parent) {
            return;
        }
        const message = e.data;
        if (!message || typeof message !== 'object' || message.type !== EVENT_TYPE) {
            return;
        }
        if (message.event === 'keydown' && typeof message.key === 'string') {
            dispatchKey(message.key, e.origin);
        }
    }

    if (window.parent !== window) {
        window.addEventListener('message', onMessage);
    }
})();
