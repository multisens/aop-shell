const ejs = require('ejs');
const express = require('express');
const path = require('path');
const core = require('../../core');
const logger = require('../../logger');

// Key codes of the keydown route.
const KEY_ESCAPE = '27';
const KEY_CONTEXT_MENU = '93';
const KEY_PAGE_UP = '33';
const KEY_PAGE_DOWN = '34';
const KEY_HOME = '36';

const router = express.Router();

// The page connects MQTT on its own origin, on /mqtt (../../mqtt-ws.js): the
// view gets no host or port of the broker.
router.get('/', async (req, res) => {
    const html = await ejs.renderFile(path.join(__dirname, 'view.ejs'), {});
    res.send(html);
});

router.get('/ready', (req, res) => {
    core.setDisplayGui(core.GUI.profile_chooser);
    res.status(200).send();
});

router.get('/keydown/:keyCode', (req, res) => {
    switch (req.params.keyCode) {
        case KEY_ESCAPE:
        case KEY_CONTEXT_MENU:
        case KEY_HOME:
            core.openServiceInfo();
            break;
        case KEY_PAGE_UP:
            logger.info('[keys] channel +');
            break;
        case KEY_PAGE_DOWN:
            logger.info('[keys] channel -');
            break;
        default:
            break;
    }
    res.status(200).send();
});

module.exports = router;
