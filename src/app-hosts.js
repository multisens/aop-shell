// Origins of the broadcaster applications. A broadcast application opens on
// the origin of its Application Context ID, served by the object proxy:
// http://ctx-<h>.<APPS_DOMAIN>:<OBJECT_PROXY_PUBLIC_PORT> (implementation
// document, 5.4); a broadband one, on the origin of its bbandEntryPointUrl.
const crypto = require('crypto');

const DEFAULT_APPS_DOMAIN = 'apps.localhost';
const DEFAULT_PUBLIC_PORT = 8080;
const DEFAULT_PROXY_PUBLIC_PORT = 8081;
const HTTP_PORT = 80;
const MAX_PORT = 65535;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Full name of at most 253: label (63) + '.' + domain.
const MAX_DOMAIN = 253 - 64;
// 5.4: ctx- and the first 16 hexadecimal digits of the SHA-256 of the
// appContextId in UTF-8.
const CONTEXT_LABEL_PREFIX = 'ctx-';
const CONTEXT_HASH_DIGITS = 16;
const HTTP_PROTOCOLS = ['http:', 'https:'];

// The domain of the applications, the public port of the AoP and that of
// the object proxy, as the browser uses them (in the compose, the ones
// published on the host). *.localhost resolves to the machine of whoever
// opens the page.
function appsConfig(env = process.env) {
    const rawDomain = env.APPS_DOMAIN === undefined ? '' : String(env.APPS_DOMAIN);
    const domain = (rawDomain.trim() || DEFAULT_APPS_DOMAIN).toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!domain || domain.length > MAX_DOMAIN || !domain.split('.').every((label) => LABEL_RE.test(label))) {
        throw new Error(`APPS_DOMAIN invalido: '${rawDomain}' (nome DNS: rotulos [a-z0-9-] separados por ponto)`);
    }
    const port = portOf('AOP_PUBLIC_PORT', env.AOP_PUBLIC_PORT || env.PORT || DEFAULT_PUBLIC_PORT);
    const proxyPort = portOf('OBJECT_PROXY_PUBLIC_PORT', env.OBJECT_PROXY_PUBLIC_PORT || DEFAULT_PROXY_PUBLIC_PORT);
    return Object.freeze({ domain, port, proxyPort });
}

// The DNS label of the origin of an Application Context ID.
function contextLabel(appContextId) {
    const digest = crypto.createHash('sha256').update(String(appContextId), 'utf8').digest('hex');
    return CONTEXT_LABEL_PREFIX + digest.slice(0, CONTEXT_HASH_DIGITS);
}

// <app:{appContextId}>, as the browser writes it in the Origin header (port
// 80 omitted).
function contextOrigin(appContextId, cfg) {
    return `http://${contextLabel(appContextId)}.${cfg.domain}${portSuffix(cfg.proxyPort)}`;
}

// <comporta>/svc/{serviceId}, as the browser reaches it, without the final
// '/'.
function serviceProxyBase(serviceId, cfg) {
    return `http://${cfg.domain}${portSuffix(cfg.proxyPort)}/svc/${serviceId}`;
}

// The launch by broadcast: <app:{appContextId}>/ + bcastEntryPointUrl
// (5.4).
function broadcastLaunch(appContextId, bcastEntryPointUrl, cfg) {
    const origin = contextOrigin(appContextId, cfg);
    return { origin, url: `${origin}/${bcastEntryPointUrl}` };
}

// The launch by broadband: the bbandEntryPointUrl, on its own origin; null
// when it is not an absolute http(s) URL.
function broadbandLaunch(bbandEntryPointUrl) {
    let url;
    try {
        url = new URL(bbandEntryPointUrl);
    } catch (err) {
        return null;
    }
    if (!HTTP_PROTOCOLS.includes(url.protocol)) {
        return null;
    }
    return { origin: url.origin, url: url.href };
}

// Label of the Host header in the domain of the applications; null outside
// it.
function hostLabel(host, cfg) {
    if (!host) {
        return null;
    }
    let name = String(host).trim().toLowerCase();
    // IPv6 literal: never an application host.
    if (name.startsWith('[')) {
        return null;
    }
    name = name.replace(/:\d*$/, '').replace(/\.$/, '');
    const suffix = `.${cfg.domain}`;
    if (!name.endsWith(suffix)) {
        return null;
    }
    return name.slice(0, -suffix.length);
}

function portOf(name, value) {
    const raw = String(value).trim();
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || port < 1 || port > MAX_PORT) {
        throw new Error(`${name} invalida: '${raw}' (inteiro de 1 a ${MAX_PORT})`);
    }
    return port;
}

function portSuffix(port) {
    if (port === HTTP_PORT) {
        return '';
    }
    return `:${port}`;
}

module.exports = {
    DEFAULT_APPS_DOMAIN,
    DEFAULT_PUBLIC_PORT,
    DEFAULT_PROXY_PUBLIC_PORT,
    appsConfig,
    contextLabel,
    contextOrigin,
    serviceProxyBase,
    broadcastLaunch,
    broadbandLaunch,
    hostLabel,
};
