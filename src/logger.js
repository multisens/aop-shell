// Service logger: timestamped lines, errors through console.error.

const LEVELS = ['ERROR', 'INFO', 'DEBUG'];
const LOG_LEVEL = currentLevel();

function debug(message) {
    if (enabled('DEBUG')) {
        console.log(line('DEBUG', message));
    }
}

function info(message) {
    if (enabled('INFO')) {
        console.log(line('INFO', message));
    }
}

function error(message) {
    console.error(line('ERROR', message));
}

function currentLevel() {
    const value = process.env.LOG_LEVEL || 'INFO';
    if (!LEVELS.includes(value)) {
        throw new Error(`LOG_LEVEL must be one of ${LEVELS.join(', ')}; got '${value}'`);
    }
    return value;
}

function enabled(level) {
    return LEVELS.indexOf(level) <= LEVELS.indexOf(LOG_LEVEL);
}

function line(level, message) {
    return `[${new Date().toISOString()}] [${level}] ${message}`;
}

module.exports = { debug, info, error };
