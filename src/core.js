require('dotenv').config();
const mqtt = require('mqtt');
const logger = require('./logger');
const redis = require('./redis-client');
const redisFunctions = require('./redis-functions');
const { whenReady } = require('./redis-options');
const profiles = require('./modules/profile-manager/service');
const lls = require('./modules/transport-layer-metadata-lls');
const appHosts = require('./app-hosts');

// Own origin of each application (./app-hosts.js), already validated.
const APPS = appHosts.appsConfig();

// origins:associated: origin of the running application (the one the
// browser sends in the Origin of its calls, not the proxy target) to the
// current globalServiceId. Cleared at boot.
const ORIGINS_KEY = 'origins:associated';

const MQTT_CLIENT_ID = 'aop-core';
const MQTT_CONNECT_TIMEOUT_MS = 4000;
const USER_LOAD_ATTEMPTS = 5;
const USER_LOAD_STEP_MS = 2000;
const BALD_FRAGMENT = 'bald';

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
    application_state: 'aop/application-lifecycle-manager/application-state',
};

const DATA = {
    rxgui: {
        current: '',
        previous: '',
    },
    // Application in the graphics layer: { appId, label, origin, target } or
    // null.
    graphicsApp: null,
    videoStreamURL: '',
    currentUser: '',
    users: [],
    // globalServiceId of the service in use, and its serviceId (the key of
    // the SLS topics), from the SLT.
    currentService: '',
    currentServiceId: undefined,
    serviceMetadata: {},
};

// Handler of each subscribed topic filter.
const handlers = new Map([
    [TOPICS.current_user, loadCurrentUser],
    [TOPICS.current_service, loadCurrentService],
    [lls.TOPIC, lls.receive],
]);

const client = mqtt.connect(`mqtt://${process.env.MQTT_HOST}`, {
    clientId: MQTT_CLIENT_ID,
    clean: true,
    connectTimeout: MQTT_CONNECT_TIMEOUT_MS,
});

function setDisplayGui(screen) {
    client.publish(TOPICS.gui_layer, screen);
    DATA.rxgui.previous = DATA.rxgui.current;
    DATA.rxgui.current = screen;
}

// baseUrl = bcastEntryPackageUrl (proxy target), epUrl = bcastEntryPointUrl,
// appId = appId of the BALD (host label; without it, the current service).
// Without baseUrl, ends the application. Publishes at once; the promise is
// the one of the registration.
function setDisplayGraphics(baseUrl = '', epUrl = '', appId = '') {
    let next = null;
    if (baseUrl !== '') {
        next = appHosts.describeApp(appId || DATA.currentService, baseUrl, APPS);
        if (!next) {
            logger.error(`[apps] invalid bcastEntryPackageUrl, application not opened: '${baseUrl}'`);
        }
    }

    const pending = [];
    const previous = DATA.graphicsApp;
    if (previous && (!next || previous.origin !== next.origin)) {
        pending.push(unregisterAssociatedOrigin(previous.origin));
    }
    if (next) {
        pending.push(registerAssociatedOrigin(next.origin));
    }

    // The application that leaves ends before the one that enters starts.
    if (previous) {
        publishApplicationState(previous, 'ended');
    }
    DATA.graphicsApp = next ? { ...next, serviceContextId: DATA.currentService } : null;
    if (DATA.graphicsApp && DATA.graphicsApp.serviceContextId) {
        publishApplicationState(DATA.graphicsApp, 'started');
    }
    client.publish(TOPICS.graphics_layer, next ? appHosts.entryUrl(next.origin, epUrl) : '');
    return Promise.all(pending).then(() => undefined);
}

function setVideoURL(url = '') {
    if (url.endsWith('m3u8') || url.endsWith('mpd')) {
        const file = url.split('/').pop();
        DATA.videoStreamURL = url.replace(`/${file}`, '');
        client.publish(TOPICS.pmplayer_url, `/videoStreamProxy/${file}`);
    } else {
        client.publish(TOPICS.pmplayer_url, url);
    }
}

function setVideoSize(top = '0', left = '0', width = '100%', height = '100%') {
    client.publish(TOPICS.pmplayer_size, JSON.stringify({ top, left, width, height }));
}

// Writes lastAccess first: if storage fails, the change does not happen and
// the error is thrown.
async function setCurrentUser(uid) {
    await profiles.touchLastAccess(uid.toString());
    DATA.currentUser = uid.toString();
    client.publish(TOPICS.current_user, uid.toString(), { retain: true });
}

function getCurrentUser() {
    return DATA.currentUser;
}

// A profile already removed from storage: removing the current one leaves
// aop/currentUser empty until the choice in the chooser; the removal goes to
// aop/removedUser, and the platform goes back to the profile chooser.
function profileRemoved(uid) {
    const index = DATA.users.findIndex((user) => user.id === uid);
    if (index >= 0) {
        DATA.users.splice(index, 1);
    }
    if (uid === DATA.currentUser) {
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

// sid is the globalServiceId. The SLS topics are the ones of its serviceId;
// a service no SLT lists has no SLS.
function setCurrentService(sid) {
    DATA.currentService = sid.toString();
    client.publish(TOPICS.current_service, sid.toString(), { retain: true });
    const announced = lls.service(DATA.currentService);
    DATA.currentServiceId = announced ? announced.serviceId : undefined;
    if (DATA.currentServiceId === undefined) {
        logger.error(`[sls] no SLT lists ${DATA.currentService}: its SLS is not subscribed`);
        return;
    }
    client.subscribe(slsFilter(DATA.currentServiceId), { noLocal: true });
}

function unsetCurrentService() {
    if (DATA.currentServiceId !== undefined) {
        client.unsubscribe(slsFilter(DATA.currentServiceId), { noLocal: true });
    }
    client.publish(TOPICS.current_service, '', { retain: true });
    DATA.currentService = '';
    DATA.currentServiceId = undefined;
    DATA.serviceMetadata = {};
}

// { serviceContextId, bam, serviceId } of the current service, from the
// received LLS.
function getCurrentService() {
    return lls.service(DATA.currentService);
}

function getServiceSLS() {
    return DATA.serviceMetadata;
}

function setBALDHandler(handler) {
    DATA.serviceMetadata.baldHandler = handler;
}

// Application running in the graphics layer ({ appId, label, origin, target
// }) or null.
function getGraphicsApp() {
    return DATA.graphicsApp;
}

// Application running with this host label, or null.
function getGraphicsAppByLabel(label) {
    return DATA.graphicsApp && DATA.graphicsApp.label === label ? DATA.graphicsApp : null;
}

function getVideoStreamURL() {
    return DATA.videoStreamURL;
}

// Returns the promise of the removal of the associated origin.
function openServiceInfo() {
    if (DATA.rxgui.current === '') {
        setDisplayGui(`${GUI.bootstrap_app}?mode=info`);
    }
    if (DATA.graphicsApp) {
        return setDisplayGraphics();
    }
    return Promise.resolve();
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

function registerAssociatedOrigin(origin) {
    const scid = DATA.currentService;
    if (!scid) {
        return Promise.reject(new Error(`no current service: origin ${origin} not registered as associated`));
    }
    return redisFunctions.originRegister(origin, scid).then(() => origin);
}

function unregisterAssociatedOrigin(origin) {
    return redisFunctions.originRemove(origin).then(() => undefined);
}

// Change of state of the application, for the other components; published
// here until the Application Lifecycle Manager exists.
function publishApplicationState(app, state) {
    const message = { serviceContextId: app.serviceContextId, appId: app.appId, origin: app.origin, state };
    client.publish(TOPICS.application_state, JSON.stringify(message));
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

function loadCurrentService(message) {
    DATA.currentService = message.toString();
}

// Of the SLS fragments, only the BALD is read here; the others are left to
// their consumers.
function loadSLSMetadata(meta, topic) {
    const fragment = topic.split('/').at(-1);
    if (fragment !== BALD_FRAGMENT) {
        return;
    }

    if (!meta) {
        DATA.serviceMetadata.bald = undefined;
        DATA.serviceMetadata.baldHandler = undefined;
        return;
    }

    let content;
    try {
        content = JSON.parse(meta);
    } catch (err) {
        logger.error(`[sls] BALD of ${topic} ignored: ${err.message}`);
        return;
    }
    DATA.serviceMetadata.bald = content;
    if (DATA.serviceMetadata.baldHandler) {
        DATA.serviceMetadata.baldHandler(content);
    }
}

// tlm/sls/<serviceId>/#.
function slsFilter(serviceId) {
    return TOPICS.sls_metadata.replace('+', String(serviceId));
}

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

function onConnect() {
    logger.info('Connected to MQTT broker');
    handlers.forEach((_, filter) => {
        client.subscribe(filter, { noLocal: true });
    });

    // Additional topics to handle, but no subscribe yet
    handlers.set(TOPICS.sls_metadata, loadSLSMetadata);

    loadUserData();
}

function onMessage(topic, message) {
    for (const [filter, handler] of handlers) {
        if (mqttTopicMatch(topic, filter)) {
            handler(message.toString(), topic);
            return;
        }
    }
    logger.info(`no handler for topic ${topic}`);
}

whenReady(redis, `limpeza de ${ORIGINS_KEY}`, () => redisFunctions.originsClear());
lls.start((topic, message) => client.publish(topic, message, { retain: true }));
client.on('connect', onConnect);
client.on('message', onMessage);

module.exports = {
    GUI,
    setDisplayGui,
    setDisplayGraphics,
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
    setBALDHandler,
    getGraphicsApp,
    getGraphicsAppByLabel,
    getVideoStreamURL,
    openServiceInfo,
    loadUserData,
    refreshUserData,
};
