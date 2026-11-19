// HTTP server of the AoP: the platform pages and routes, the application
// hosts and the MQTT over WebSocket of the TV page.
const { PORT, APPS, MQTT_WS } = require('./environment');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const logger = require('./logger');
const appHosts = require('./app-hosts');
const mqttWs = require('./mqtt-ws');
const core = require('./core');
const { platformErrorHandler } = require('./http-error');
const graphicOverlays = require('./modules/graphic-overlays');
const profileChooser = require('./modules/profile-manager/chooser');
const profileManager = require('./modules/profile-manager/manager');
const applicationCatalog = require('./modules/application-catalog');
const bootstrapApplication = require('./modules/bootstrap-application');

const VIDEO_PROXY_PATH = '/videoStreamProxy';
const HTTP_PORT_DEFAULT = 80;

function corsHeaders(req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
    next();
}

// B.6.3: the proxy keeps the cache metadata of the origin (ETag,
// Last-Modified, Expires). A live playlist declares its own validity at the
// origin; it is not made uncacheable here.
function videoStreamProxy() {
    return createProxyMiddleware({
        target: '',
        changeOrigin: true,
        router: () => core.getVideoStreamURL(),
        pathRewrite: { [`^${VIDEO_PROXY_PATH}`]: '' },
        on: {
            error: (err, req, res) => {
                logger.error(`[video] proxy error: ${err.message}`);
                res.status(500).send('VideoStreamProxy Error');
            },
        },
    });
}

function appsAddress() {
    const port = APPS.port === HTTP_PORT_DEFAULT ? '' : `:${APPS.port}`;
    return `http://<app>.${APPS.domain}${port}`;
}

const app = express();

// An application host (<label>.<APPS_DOMAIN>) goes to the proxy of the
// running application; without one, 404. Mounted first: an application host
// never serves the pages or the files of the AoP, and the body reaches the
// target intact.
app.use(appHosts.appHostProxy({ cfg: APPS, lookup: core.getGraphicsAppByLabel }));
logger.info(`[apps] aplicacoes de emissora em ${appsAddress()}`);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', 'src/views');
app.use(corsHeaders);

app.use(core.GUI.profile_chooser, profileChooser);
app.use('/profile', profileManager);
app.use(core.GUI.app_catalogue, applicationCatalog);
app.use(core.GUI.bootstrap_app, bootstrapApplication);
app.use('/', graphicOverlays);

// /graphicsAppProxy on the host of the AoP: 302 to the same path on the
// host of the running application; without one, 404 (./app-hosts.js).
app.use('/graphicsAppProxy', appHosts.legacyGraphicsRedirect({ getApp: core.getGraphicsApp }));
app.use(VIDEO_PROXY_PATH, videoStreamProxy());

// An exception in a route (e.g. Redis down) becomes 404 {error:200} (C.3.2).
app.use(platformErrorHandler);

const server = app.listen(PORT, () => {
    logger.info(`AoP running on port: ${PORT}`);
});

// WebSocket upgrade: only /mqtt on the host of the AoP goes to the broker;
// anything else (another path, an application host) answers 404.
server.on('upgrade', mqttWs.mqttWsUpgrade({ apps: APPS, mqtt: MQTT_WS }));
logger.info(`[mqtt-ws] MQTT por WebSocket em ws://<host do AoP>${mqttWs.MQTT_WS_PATH} -> ${MQTT_WS.target}`);

if (process.send) {
    process.send('ready');
}
