require('dotenv').config();
const mqtt = require('mqtt');
const logger = require('./logger');
const redis = require('./redis-client');
const redisFunctions = require('./redis-functions');
const profiles = require('./modules/profile-manager/service');
const lls = require('./modules/transport-layer-metadata-lls');
const catalog = require('./modules/application-catalog/catalog');
const dashStreams = require('./modules/dash-streams');

const MQTT_CLIENT_ID = 'aop-core';
const MQTT_CONNECT_TIMEOUT_MS = 4000;
const USER_LOAD_ATTEMPTS = 5;
const USER_LOAD_STEP_MS = 2000;
const MPD_FRAGMENT = 'mpd';
// SLT Service@configuration when absent.
const DEFAULT_CONFIGURATION = 'Broadcast';
const ABSOLUTE_URL = /^https?:\/\//;

const GUI = {
    app_catalogue: '/appcat',
    profile_chooser: '/prfchs',
    profile_creator: '/profile/create',
    bootstrap_app: '/btpapp',
};

const TOPICS = {
    current_user: 'aop/currentUser',
    removed_user: 'aop/removedUser',
    current_service: 'aop/currentService',
    sls_metadata: 'tlm/sls/+/#',
    gui_layer: 'aop/display/layers/rxgui',
    pmplayer_url: 'aop/display/layers/video/url',
    pmplayer_size: 'aop/display/layers/video/size',
    graphics_layer: 'aop/display/layers/graphics',
    tuned: 'tlm/tuned',
    graphics_application: 'aop/application-lifecycle-manager/graphics-application',
    end_request: 'aop/application-lifecycle-manager/end-request',
};

const DATA = {
    // The screen of the interface layer and the one before it; component is
    // true while the screen is one a component published.
    rxgui: {
        current: '',
        previous: '',
        component: false,
    },
    // Application in the graphics layer, as aop-application-lifecycle-manager
    // publishes it: { serviceContextId, appId, origin, url }, or null for
    // the Bootstrap Application.
    graphicsApp: null,
    currentUser: '',
    users: [],
    // globalServiceId of the service in use, and its entry in the
    // Application Catalog: { serviceContextId, bam, serviceId, bsid,
    // configuration }, serviceId being the key of the SLS topics and
    // configuration the one of its SLT Service element.
    currentService: '',
    currentEntry: undefined,
    serviceMetadata: {},
};

// Handler of each subscribed topic filter.
const handlers = new Map([
    [TOPICS.current_user, loadCurrentUser],
    [TOPICS.current_service, loadCurrentService],
    [lls.TOPIC, lls.receive],
    [catalog.SCAN_TOPIC, catalog.receiveScan],
    [TOPICS.graphics_application, loadGraphicsApplication],
    [TOPICS.gui_layer, loadInterfaceScreen],
]);

function setDisplayGui(screen) {
    client.publish(TOPICS.gui_layer, screen);
    DATA.rxgui.previous = DATA.rxgui.current;
    DATA.rxgui.current = screen;
    DATA.rxgui.component = false;
}

// A screen of the interface layer published by a component: an absolute
// URL. The screens of the platform are paths (GUI) and come back here from
// setDisplayGui; they are ignored.
function loadInterfaceScreen(screen) {
    if (!ABSOLUTE_URL.test(screen) || screen === DATA.rxgui.current) {
        return;
    }
    if (!DATA.rxgui.component) {
        DATA.rxgui.previous = DATA.rxgui.current;
    }
    DATA.rxgui.current = screen;
    DATA.rxgui.component = true;
}

// With a screen of a component in the interface layer, goes back to the
// screen before it; true if it did.
function closeComponentScreen() {
    if (!DATA.rxgui.component) {
        return false;
    }
    setDisplayGui(DATA.rxgui.previous);
    return true;
}

// The media source of the Persistent Media Player; empty stops it.
function setVideoURL(url = '') {
    client.publish(TOPICS.pmplayer_url, url);
}

function setVideoSize(top = '0', left = '0', width = '100%', height = '100%') {
    client.publish(TOPICS.pmplayer_size, JSON.stringify({ top, left, width, height }));
}

// Writes lastAccess and session:current-user before aop/currentUser: if
// storage fails, the change does not happen and the error is thrown.
async function setCurrentUser(uid) {
    const id = uid.toString();
    await profiles.touchLastAccess(id);
    await redisFunctions.sessionUser(id);
    DATA.currentUser = id;
    client.publish(TOPICS.current_user, id, { retain: true });
}

function getCurrentUser() {
    return DATA.currentUser;
}

// A profile already removed from storage: removing the current one leaves
// session:current-user and aop/currentUser empty until the choice in the
// chooser; the removal goes to aop/removedUser, and the platform goes back
// to the profile chooser. A Redis failure rejects.
async function profileRemoved(uid) {
    const index = DATA.users.findIndex((user) => user.id === uid);
    if (index >= 0) {
        DATA.users.splice(index, 1);
    }
    if (uid === DATA.currentUser) {
        await redisFunctions.sessionUser('');
        DATA.currentUser = '';
        client.publish(TOPICS.current_user, '', { retain: true });
    }
    client.publish(TOPICS.removed_user, uid);
    setDisplayGui(GUI.profile_chooser);
}

function getUserData(uid) {
    return DATA.users.find((user) => user.id === String(uid)) || {};
}

function getUserList() {
    return DATA.users;
}

// sid is the globalServiceId. The session (Table C.8) is written before
// aop/currentService is published, with the serviceName and serviceId of the
// catalog entry; the SLS topics are the ones of that serviceId. A service
// outside the catalog has neither, nor SLS. A Redis failure rejects, with
// nothing published.
async function setCurrentService(sid) {
    const tunedAt = new Date();
    const serviceContextId = sid.toString();
    DATA.currentService = serviceContextId;
    DATA.currentEntry = undefined;
    const entry = await catalog.service(serviceContextId);
    await redisFunctions.sessionService(sessionFields(serviceContextId, entry));
    if (DATA.currentService !== serviceContextId) {
        return;
    }
    client.publish(TOPICS.current_service, serviceContextId, { retain: true });
    DATA.currentEntry = withConfiguration(entry);
    if (!entry) {
        logger.error(`[sls] ${DATA.currentService} is not in the Application Catalog: its SLS is not subscribed`);
        return;
    }
    dashStreams.select(entry.serviceId);
    client.subscribe(slsFilter(entry.serviceId), { noLocal: true });
    publishTuning(entry, tunedAt);
}

// The session is cleared before aop/currentService is emptied; a Redis
// failure rejects, with nothing changed.
async function unsetCurrentService() {
    await redisFunctions.sessionServiceClear();
    if (DATA.currentEntry) {
        client.unsubscribe(slsFilter(DATA.currentEntry.serviceId), { noLocal: true });
    }
    client.publish(TOPICS.current_service, '', { retain: true });
    client.publish(TOPICS.tuned, '', { retain: true });
    DATA.currentService = '';
    DATA.currentEntry = undefined;
    DATA.serviceMetadata = {};
    dashStreams.clear();
}

// { serviceContextId, bam, serviceId, bsid, configuration } of the current
// service, from the Application Catalog, or undefined.
function getCurrentService() {
    return DATA.currentEntry;
}

// The broadcaster application in the graphics layer, or null.
function getGraphicsApp() {
    return DATA.graphicsApp;
}

function getServiceSLS() {
    return DATA.serviceMetadata;
}

// With a broadcaster application in the graphics layer, asks
// aop-application-lifecycle-manager to end it (the Bootstrap Application
// returns by loadGraphicsApplication); without one, shows the information
// of the Bootstrap Application.
function openServiceInfo() {
    if (DATA.graphicsApp) {
        const request = { serviceContextId: DATA.graphicsApp.serviceContextId, appId: DATA.graphicsApp.appId };
        client.publish(TOPICS.end_request, JSON.stringify(request));
        return;
    }
    if (DATA.rxgui.current === '') {
        openBootstrapInfo();
    }
}

function openBootstrapInfo() {
    setDisplayGui(`${GUI.bootstrap_app}?mode=info`);
}

// Profiles read directly from storage, all of them, without the visibility
// filter. A base without profiles gets the default profile. A Redis failure
// rejects.
async function refreshUserData() {
    let ids = await redis.smembers('users:index');
    if (ids.length === 0) {
        await profiles.ensureDefaultProfile();
        ids = await redis.smembers('users:index');
    }

    const details = await Promise.all(ids.map(async (id) => {
        const stored = await redis.hgetall(`user:${id}`);
        return { id, name: stored.nickname || stored.name || id, avatar: stored.avatar || null };
    }));

    DATA.users.length = 0;
    details.forEach((user) => DATA.users.push(user));
    logger.info(`Loaded ${DATA.users.length} users from Redis`);
}

// Boot and MQTT path: retries and logs. Without a current profile, the
// first one; after that, only the choice in the chooser sets it.
async function loadUserData(attempt = 1) {
    try {
        await refreshUserData();
        if (DATA.users.length > 0 && !DATA.currentUser) {
            await setCurrentUser(DATA.users[0].id);
        }
    } catch (err) {
        // Redis may be slow to start: retry, with backoff.
        if (attempt < USER_LOAD_ATTEMPTS) {
            const delay = attempt * USER_LOAD_STEP_MS;
            logger.info(`Loading users from Redis failed (attempt ${attempt}/${USER_LOAD_ATTEMPTS}, `
                + `retry in ${delay}ms): ${err.message}`);
            setTimeout(() => loadUserData(attempt + 1), delay);
        } else {
            logger.error(`Gave up loading users from Redis after ${attempt} attempts: ${err.message}`);
        }
    }
}

// tlm/tuned: the service of the Bootstrap Application instance and the instant
// it became the current service.
function publishTuning(entry, tunedAt) {
    const tuning = { serviceId: entry.serviceId, rfChannelId: entry.bsid, tunedAt: tunedAt.toISOString() };
    client.publish(TOPICS.tuned, JSON.stringify(tuning), { retain: true });
}

// Writes lastAccess on every change of the current user, including one that
// arrives on aop/currentUser. The echo of its own publication is ignored;
// the retained message received at boot counts as an access.
function loadCurrentUser(message) {
    const uid = message.toString();
    if (uid === DATA.currentUser) {
        return;
    }
    DATA.currentUser = uid;
    profiles.touchLastAccess(uid).catch((err) => {
        logger.error(`[profiles] failed to write lastAccess of ${uid}: ${err.message}`);
    });
}

// The retained service at boot: its catalog entry is read again, and the
// session is rewritten from it.
async function loadCurrentService(message) {
    const sid = message.toString();
    if (sid === DATA.currentService) {
        return;
    }
    DATA.currentService = sid;
    DATA.currentEntry = undefined;
    if (!sid) {
        return;
    }
    const entry = await catalog.service(sid);
    await redisFunctions.sessionService(sessionFields(sid, entry));
    if (DATA.currentService === sid) {
        DATA.currentEntry = withConfiguration(entry);
    }
}

// Of the SLS fragments, the MPD goes to aop-dash-streams; the others are
// left to their consumers.
function loadSLSMetadata(meta, topic) {
    const parts = topic.split('/');
    const fragment = parts.at(-1);
    if (fragment === MPD_FRAGMENT) {
        dashStreams.receive(parts[2], meta);
    }
}

// The application aop-application-lifecycle-manager put in the graphics
// layer: it replaces the Bootstrap Application, with the video in full
// screen. Empty: the application ended, and the Bootstrap Application of
// the tuned service returns in its initial state (BpAFR-08).
function loadGraphicsApplication(message) {
    if (!message) {
        const hadApp = DATA.graphicsApp !== null;
        DATA.graphicsApp = null;
        client.publish(TOPICS.graphics_layer, '');
        if (hadApp && DATA.currentEntry) {
            openBootstrapInfo();
        }
        return;
    }
    let app;
    try {
        app = JSON.parse(message);
    } catch (err) {
        logger.error(`[apps] graphics application ignored: ${err.message}`);
        return;
    }
    DATA.graphicsApp = app;
    setDisplayGui('');
    setVideoSize();
    client.publish(TOPICS.graphics_layer, app.url);
    logger.info(`[apps] ${app.appId} in the graphics layer at ${app.url}`);
}

function onConnect() {
    logger.info('Connected to MQTT broker');
    handlers.forEach((_, filter) => {
        client.subscribe(filter, { noLocal: true });
    });

    // Topics of the current service: handled here, subscribed by
    // setCurrentService.
    handlers.set(TOPICS.sls_metadata, loadSLSMetadata);

    loadUserData();
}

// A handler may return a promise: its failure goes to the log.
function onMessage(topic, message) {
    for (const [filter, handler] of handlers) {
        if (mqttTopicMatch(topic, filter)) {
            Promise.resolve(handler(message.toString(), topic)).catch((err) => {
                logger.error(`[mqtt] handler of ${topic} failed: ${err.message}`);
            });
            return;
        }
    }
    logger.info(`no handler for topic ${topic}`);
}

// The fields of Table C.8 of the current service: serviceName is the appName
// of the BAM and serviceId the one of the SLT, from the catalog entry; empty
// for a service outside the catalog.
function sessionFields(serviceContextId, entry) {
    if (!entry) {
        return { serviceContextId, serviceName: '', serviceId: '' };
    }
    return { serviceContextId, serviceName: entry.bam.appName || '', serviceId: String(entry.serviceId) };
}

// The catalog entry with the configuration of its SLT Service element, or
// undefined without an entry.
function withConfiguration(entry) {
    if (!entry) {
        return undefined;
    }
    const sltService = lls.service(entry.bsid, entry.serviceId);
    const configuration = sltService && sltService.configuration ? sltService.configuration : DEFAULT_CONFIGURATION;
    return { ...entry, configuration };
}

// tlm/sls/<serviceId>/#.
function slsFilter(serviceId) {
    return TOPICS.sls_metadata.replace('+', String(serviceId));
}

// Whether a topic matches a subscription filter, with + and #.
function mqttTopicMatch(topic, filter) {
    const levels = filter.split('/').map((level) => {
        if (level === '+') {
            return '[^/#+]+';
        }
        if (level === '#') {
            return '.*';
        }
        return level.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    return new RegExp(`^${levels.join('/')}$`).test(topic);
}

const client = mqtt.connect(`mqtt://${process.env.MQTT_HOST}`, {
    clientId: MQTT_CLIENT_ID,
    clean: true,
    connectTimeout: MQTT_CONNECT_TIMEOUT_MS,
});
catalog.start((topic, message) => client.publish(topic, message, { retain: true }));
client.on('connect', onConnect);
client.on('message', onMessage);

module.exports = {
    GUI,
    setDisplayGui,
    setVideoURL,
    setVideoSize,
    setCurrentUser,
    getCurrentUser,
    profileRemoved,
    getUserData,
    getUserList,
    setCurrentService,
    unsetCurrentService,
    getCurrentService,
    getServiceSLS,
    getGraphicsApp,
    openServiceInfo,
    closeComponentScreen,
    loadUserData,
    refreshUserData,
};
