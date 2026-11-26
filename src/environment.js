// Configuration of the boot, checked when the module is loaded: a missing
// required variable, or an invalid APPS_DOMAIN, AOP_PUBLIC_PORT or MQTT
// WebSocket setting, stops the process (exit 1) before any other module of
// the AoP is loaded.
require('dotenv').config();
const logger = require('./logger');
const appHosts = require('./app-hosts');
const mqttWs = require('./mqtt-ws');

const REQUIRED = ['MQTT_HOST', 'REDIS_HOST'];
const DEFAULT_PORT = 8080;

function assertRequired() {
    const missing = REQUIRED.filter((name) => {
        const value = process.env[name];
        return !value || String(value).trim() === '';
    });
    if (missing.length > 0) {
        stop(`missing required env vars: ${missing.join(', ')}; check docker-compose.yml or .env`);
    }
}

// The value of read(), or the stop of the boot with its error.
function checked(read) {
    try {
        return read();
    } catch (err) {
        stop(err.message);
        return undefined;
    }
}

function stop(message) {
    logger.error(`[boot] ${message}`);
    process.exit(1);
}

assertRequired();

module.exports = {
    PORT: process.env.PORT || DEFAULT_PORT,
    // Own origin of each application (./app-hosts.js).
    APPS: checked(() => appHosts.appsConfig()),
    // MQTT over WebSocket of the TV page: comes in through the AoP port, on
    // /mqtt, and goes on to ws://${MQTT_HOST}:${MQTT_WS_PORT} (./mqtt-ws.js).
    MQTT_WS: checked(() => mqttWs.mqttWsConfig()),
};
