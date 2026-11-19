const core = require('../../core');
const logger = require('../../logger');
const appHosts = require('../../app-hosts');
const dashStreams = require('../dash-streams');
const { avatarHtml } = require('../profile-manager/avatar');
const { escapeHtml, svgImageHtml, cssHexColor } = require('../../html');

// Colors of the <style> of the view: only the format passes (cssHexColor);
// outside it, the palette of the other AoP screens. BAM, Table 6:
// "Hexadecimal RGB color code with notation using a leading number sign (#)",
// so #RRGGBB. The genre color, a field of the provisional SLS format of the
// testbed: #RRGGBB or #RRGGBBAA.
const DEFAULT_BACKGROUND_COLOR = '#282828';
const DEFAULT_FOREGROUND_COLOR = '#c8c8c8';
const DEFAULT_GENRE_COLOR = 'transparent';
const INFO_MODE = 'info';
const HTML5_APP_TYPE = 'TV30-Ginga-HTML5';
const AUTOSTART = 'AUTOSTART';
const HTTP_PROTOCOLS = ['http:', 'https:'];
const MPD_EXTENSION = '.mpd';
// Origins of the applications, already checked at boot (environment.js).
const APPS = appHosts.appsConfig();
const HLS_EXTENSION = '.m3u8';

function profile() {
    const user = core.getUserData(core.getCurrentUser());
    return `<span>${escapeHtml(user.name || '')}</span>${avatarHtml(user.avatar)}`;
}

// initialMediaURL is the parameter of BpAFR-11, already checked
// (initialMediaParameter), or undefined.
function openBootstrapApp(mode, initialMediaURL) {
    if (mode !== INFO_MODE) {
        playInitialMedia(initialMediaURL);
    }
    core.setVideoSize('12%', '35%', '60%', '60%');
}

// The initialMediaURL parameter (BpAFR-11): undefined when absent; an
// absolute HTTP URL of an MPD or M3U8 file (ABNT NBR 25602, Table D.1);
// otherwise an Error.
function initialMediaParameter(value) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error('initialMediaURL given more than once');
    }
    let url;
    try {
        url = new URL(value);
    } catch (err) {
        throw new Error(`initialMediaURL '${value}' is not an absolute URL`);
    }
    if (!HTTP_PROTOCOLS.includes(url.protocol)) {
        throw new Error(`initialMediaURL '${value}' is not HTTP`);
    }
    if (!url.pathname.endsWith(MPD_EXTENSION) && !url.pathname.endsWith(HLS_EXTENSION)) {
        throw new Error(`initialMediaURL '${value}' is neither an MPD nor an M3U8 file`);
    }
    return value;
}

// BpAFR-10 and BpAFR-11: the initialMediaURL parameter; without it, the MPD
// of the service, from its SLS; without the MPD, the first of
// fallbackMediaURLs (Table 6) until the MPD arrives.
function playInitialMedia(initialMediaURL) {
    const entry = core.getCurrentService();
    if (!entry) {
        return;
    }
    if (initialMediaURL !== undefined) {
        play(initialMediaURL, entry);
        return;
    }
    const mpdUrl = dashStreams.mediaUrl(entry.serviceId);
    if (mpdUrl !== undefined) {
        core.setVideoURL(mpdUrl);
        return;
    }
    dashStreams.onAvailable((url) => core.setVideoURL(url));
    const fallback = (entry.bam.fallbackMediaURLs || [])[0];
    if (fallback !== undefined) {
        play(fallback, entry);
    }
}

// An HLS playlist plays only in the Broadband configuration: HLS is only
// broadband delivery (ABNT NBR 25602, Annex C).
function play(url, entry) {
    if (isHlsPlaylist(url) && entry.configuration !== dashStreams.BROADBAND) {
        logger.error(`[media] HLS refused for ${entry.serviceContextId}, configuration ${entry.configuration}: ${url}`);
        return;
    }
    core.setVideoURL(url);
}

function bootstrapAppData() {
    const bam = core.getCurrentService().bam;

    // appIconHtml (<img> with a data: URL) goes to <%- %>; the other fields
    // to <%= %>, which escapes.
    return {
        appName: bam.appName,
        appIconHtml: svgImageHtml(bam.appIcon, { alt: '' }, `appIcon do BAM de ${bam.globalServiceId}`),
        appDescription: bam.appDescription || '',
        backgroundColor: cssHexColor(bam.backgroundColor, DEFAULT_BACKGROUND_COLOR),
        foregroundColor: cssHexColor(bam.foregroundColor, DEFAULT_FOREGROUND_COLOR),
    };
}

function esgData() {
    try {
        const esg = core.getServiceSLS().esg;
        return {
            validFrom: esg.Service.validFrom,
            validTo: esg.Service.validTo,
            contentName: esg.Service.Name.text,
            contentDescription: esg.Service.Description.text,
            genreColor: cssHexColor(esg.Service.Genre.color, DEFAULT_GENRE_COLOR, { alpha: true }),
            genreTerm: esg.Service.Genre.term,
            contentAdvisoryRatings: `media/rating/${esg.Service.ContentAdvisoryRatings}.png`,
        };
    } catch (error) {
        return {
            validFrom: '',
            validTo: '',
            contentName: '',
            contentDescription: '',
            genreColor: DEFAULT_GENRE_COLOR,
            genreTerm: '',
            contentAdvisoryRatings: '',
        };
    }
}

function closeBootstrapApp(gui) {
    core.setDisplayGui(gui);
    core.setVideoURL();
    core.setVideoSize();
    core.unsetCurrentService();
}

// Returns the promise of the registration of the associated origin. Without
// a BALD yet, the start is left to the MQTT handler, which logs a failure.
function fullscreen() {
    core.setDisplayGui('');
    core.setVideoSize();
    try {
        return startApp(core.getServiceSLS().bald);
    } catch (error) {
        core.setBALDHandler((bald) => {
            startApp(bald).catch((err) => {
                logger.error(`[origins] failed to register the origin of the application: ${err.message}`);
            });
        });
        return Promise.resolve();
    }
}

// Only HTML5 applications with AUTOSTART, or no controlCode, are started.
// The BALD is { EntryPackage: [...] }.
function startApp(bald) {
    const pending = [];
    for (const entryPackage of bald.EntryPackage) {
        const autostart = !entryPackage.controlCode || entryPackage.controlCode === AUTOSTART;
        if (!autostart || entryPackage.appType !== HTML5_APP_TYPE) {
            continue;
        }
        const launch = launchOf(entryPackage);
        if (launch === null) {
            logger.error(`[apps] ${entryPackage.appId} not opened: no valid entry point`);
            continue;
        }
        pending.push(core.setDisplayGraphics({ appId: entryPackage.appId, ...launch }));
    }
    return Promise.all(pending);
}

// ABNT NBR 25608, 10.1: with both entry points, the broadband one first;
// the broadcast one opens on the origin of the Application Context ID
// (implementation document, 5.4). Null without a usable entry point.
function launchOf(entryPackage) {
    if (entryPackage.bbandEntryPointUrl !== undefined) {
        const broadband = appHosts.broadbandLaunch(entryPackage.bbandEntryPointUrl);
        if (broadband !== null) {
            return broadband;
        }
        logger.error(`[apps] bbandEntryPointUrl '${entryPackage.bbandEntryPointUrl}' is not an absolute HTTP URL`);
    }
    if (entryPackage.bcastEntryPointUrl !== undefined) {
        return appHosts.broadcastLaunch(entryPackage.appContextId, entryPackage.bcastEntryPointUrl, APPS);
    }
    return null;
}

function isHlsPlaylist(url) {
    try {
        return new URL(url).pathname.endsWith(HLS_EXTENSION);
    } catch (err) {
        return false;
    }
}

module.exports = {
    profile,
    openBootstrapApp,
    initialMediaParameter,
    bootstrapAppData,
    esgData,
    closeBootstrapApp,
    fullscreen,
};
