// The domain of the origins of the broadcaster applications and the public
// ports of the AoP and of the object proxy, as the browser uses them.
const DEFAULT_APPS_DOMAIN = 'apps.localhost';
const DEFAULT_PUBLIC_PORT = 8080;
const DEFAULT_PROXY_PUBLIC_PORT = 8081;
const HTTP_PORT = 80;
const MAX_PORT = 65535;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Full name of at most 253: label (63) + '.' + domain.
const MAX_DOMAIN = 253 - 64;

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

// <comporta>/svc/{serviceId}, as the browser reaches it, without the final
// '/'.
function serviceProxyBase(serviceId, cfg) {
    return `http://${cfg.domain}${portSuffix(cfg.proxyPort)}/svc/${serviceId}`;
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
    serviceProxyBase,
    hostLabel,
};
