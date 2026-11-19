// aop-dash-streams: GET /dash/<serviceId>/mpd serves the MPD of the current
// service to the Persistent Media Player; without one, 404. The player reads
// it again at each MPD@minimumUpdatePeriod.
const express = require('express');
const service = require('./service');

const DASH_TYPE = 'application/dash+xml';

const router = express.Router();

router.get('/:serviceId/mpd', (req, res) => {
    const mpd = service.mpd(req.params.serviceId);
    if (mpd === undefined) {
        res.status(404).send();
        return;
    }
    res.type(DASH_TYPE);
    res.set('Cache-Control', 'no-cache');
    res.send(mpd);
});

module.exports = {
    ROUTE: service.ROUTE,
    router,
    BROADBAND: service.BROADBAND,
    select: service.select,
    clear: service.clear,
    receive: service.receive,
    mediaUrl: service.mediaUrl,
    onAvailable: service.onAvailable,
};
