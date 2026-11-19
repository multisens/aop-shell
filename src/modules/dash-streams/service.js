// aop-dash-streams (7.3): the MPD of the current service, received in its
// SLS, kept for the Persistent Media Player with the base of the segment
// URLs resolved. In the Broadband configuration the base is MPD.BaseURL,
// which must be absolute; each BaseURL is a prefix of the segment URL, so
// one without the final '/' gets it. The Broadcast configuration needs the
// object proxy, not available: its MPD is refused.
const logger = require('../../logger');

const ROUTE = '/dash';
const BROADBAND = 'Broadband';
const ABSOLUTE_URL = /^https?:\/\//i;
const BASE_URL = /(<BaseURL(?:\s[^>]*)?>)([^<]*)(<\/BaseURL>)/g;
const MPD_BASE_URL = /<BaseURL(?:\s[^>]*)?>([^<]*)<\/BaseURL>/;
const PERIOD = '<Period';

// { serviceId, configuration, mpd, refusal } of the current service: mpd is
// the MPD to serve, or null; refusal the reason of the last MPD refused.
let current = null;
// Called once with the media URL when the MPD of the current service is
// first available.
let availableHandler = null;

// The current service: only its MPD is kept.
function select(serviceId, configuration) {
    current = { serviceId: String(serviceId), configuration, mpd: null, refusal: '' };
    availableHandler = null;
}

function clear() {
    current = null;
    availableHandler = null;
}

// Fragment mpd of tlm/sls/<serviceId>; an empty message removes the MPD. A
// refused MPD goes to the log when the reason changes, and the MPD is
// removed.
function receive(serviceId, message) {
    if (!current || current.serviceId !== String(serviceId)) {
        return;
    }
    if (!message) {
        current.mpd = null;
        return;
    }
    let served;
    try {
        served = servedMpd(message, current.configuration);
    } catch (err) {
        current.mpd = null;
        if (current.refusal !== err.message) {
            current.refusal = err.message;
            logger.error(`[dash] MPD of ${serviceId} refused: ${err.message}`);
        }
        return;
    }
    const first = current.mpd === null;
    current.mpd = served;
    current.refusal = '';
    if (first && availableHandler) {
        const handler = availableHandler;
        availableHandler = null;
        handler(mediaUrl(serviceId));
    }
}

// URL of the MPD of the service for the player, or undefined without one.
function mediaUrl(serviceId) {
    if (mpd(serviceId) === undefined) {
        return undefined;
    }
    return `${ROUTE}/${serviceId}/mpd`;
}

// The MPD to serve, or undefined.
function mpd(serviceId) {
    if (!current || current.serviceId !== String(serviceId) || current.mpd === null) {
        return undefined;
    }
    return current.mpd;
}

function onAvailable(handler) {
    availableHandler = handler;
}

function servedMpd(text, configuration) {
    if (configuration !== BROADBAND) {
        throw new Error(`configuration ${configuration}: the segments need the object proxy`);
    }
    const head = text.split(PERIOD)[0];
    const match = MPD_BASE_URL.exec(head);
    if (!match) {
        throw new Error('no MPD.BaseURL');
    }
    if (!ABSOLUTE_URL.test(match[1].trim())) {
        throw new Error(`MPD.BaseURL '${match[1]}' is not absolute`);
    }
    return text.replace(BASE_URL, (all, open, url, close) => `${open}${directory(url.trim())}${close}`);
}

function directory(url) {
    if (url.endsWith('/')) {
        return url;
    }
    return `${url}/`;
}

module.exports = { ROUTE, BROADBAND, select, clear, receive, mediaUrl, mpd, onAvailable };
