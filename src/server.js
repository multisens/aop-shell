// HTTP server of the AoP: the platform pages and routes and the MQTT over
// WebSocket of the TV page.
const { PORT, APPS, MQTT_WS } = require('./environment');
const express = require('express');
const logger = require('./logger');
const mqttWs = require('./mqtt-ws');
const core = require('./core');
const { platformErrorHandler } = require('./http-error');
const graphicOverlays = require('./modules/graphic-overlays');
const profileChooser = require('./modules/profile-manager/chooser');
const profileManager = require('./modules/profile-manager/manager');
const applicationCatalog = require('./modules/application-catalog');
const bootstrapApplication = require('./modules/bootstrap-application');
const dashStreams = require('./modules/dash-streams');

function corsHeaders(req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
    next();
}

const app = express();

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
app.use(dashStreams.ROUTE, dashStreams.router);
app.use('/', graphicOverlays);

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
