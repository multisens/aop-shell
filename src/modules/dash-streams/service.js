// aop-dash-streams (7.3): the MPD of the current service, received in its
// SLS, kept for the Persistent Media Player with the base of the segment
// URLs resolved (implementation document, 5.4): an absolute MPD.BaseURL is
// the external origin; a relative one goes after the base of the object
// proxy for the service, by concatenation. Each BaseURL is a prefix of the
// segment URL, so one without the final '/' gets it.
const logger = require('../../logger');
const appHosts = require('../../app-hosts');

const ROUTE = '/dash';
const BROADBAND = 'Broadband';
const ABSOLUTE_URL = /^https?:\/\//i;
const BASE_URL = /(<BaseURL(?:\s[^>]*)?>)([^<]*)(<\/BaseURL>)/g;
const MPD_BASE_URL = /<BaseURL(?:\s[^>]*)?>([^<]*)<\/BaseURL>/;
const PERIOD = '<Period';
// Origins of the applications and of the object proxy, already checked at
// boot (environment.js).
const APPS = appHosts.appsConfig();

// { serviceId, mpd, refusal } of the current service: mpd is the MPD to
// serve, or null; refusal the reason of the last MPD refused.
let current = null;
// Called once with the media URL when the MPD of the current service is
// first available.
let availableHandler = null;

// The current service: only its MPD is kept.
function select(serviceId) {
    current = { serviceId: String(serviceId), mpd: null, refusal: '' };
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
        served = servedMpd(message, current.serviceId);
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

function servedMpd(text, serviceId) {
    const head = text.split(PERIOD)[0];
    const match = MPD_BASE_URL.exec(head);
    if (!match) {
        throw new Error('no MPD.BaseURL');
    }
    const mpdBase = match[1].trim();
    const resolved = text.replace(BASE_URL, (all, open, url, close) => `${open}${directory(url.trim())}${close}`);
    if (ABSOLUTE_URL.test(mpdBase)) {
        return resolved;
    }
    const proxyBase = appHosts.serviceProxyBase(serviceId, APPS);
    return resolved.replace(MPD_BASE_URL, `<BaseURL>${proxyBase}${directory(mpdBase)}</BaseURL>`);
}

function directory(url) {
    if (url.endsWith('/')) {
        return url;
    }
    return `${url}/`;
}

module.exports = { ROUTE, BROADBAND, select, clear, receive, mediaUrl, mpd, onAvailable };
