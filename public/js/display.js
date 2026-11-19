// Page of the TV: the video, graphics and platform interface layers and the
// pop-up element, driven by the aop/display/layers topics. The pop-ups are
// handled by popup.js (handlePopupMessage, yesno_popup).

const DISPLAY_TOPIC = 'aop/display/layers/';
const VIDEO_EVENT_TOPIC = 'video/event';
const MQTT_CONNECT_TIMEOUT_MS = 4000;
const MQTT_CLIENT_ID = 'rp-display';
const PLAYER_RESTART_MS = 500;
const TIME_UPDATE_MS = 1000;
const VIDEO_ELEMENT = '<video id="video" class="video-js" autoplay muted playsinline></video>';
const DASH_TYPE = 'application/dash+xml';
const HLS_TYPE = 'application/x-mpegURL';
// 27: Escape; 33, 34: PageUp, PageDown; 93: ContextMenu.
const PLATFORM_KEYS = [27, 33, 34, 93];

let player = null;
let publishTopic = null;

// MQTT on the own origin of the page, on /mqtt; the AoP passes it on to the
// broker (src/mqtt-ws.js). location.host is the name and port by which the
// page was opened.
function connect() {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const client = mqtt.connect(`${scheme}://${window.location.host}/mqtt`, {
        clean: false,
        connectTimeout: MQTT_CONNECT_TIMEOUT_MS,
        clientId: MQTT_CLIENT_ID,
    });
    client.on('connect', () => {
        subscribeTopics(client);
        fetch('ready');
    });
    // An exception in the handling goes to the console: escaping to the MQTT
    // client, it would stop the page from handling the next messages.
    client.on('message', (topic, message) => {
        try {
            mqttMessage(topic, message);
        } catch (err) {
            console.error(`Mensagem MQTT em ${topic} nao tratada:`, err);
        }
    });
    publishTopic = (topic, message) => {
        client.publish(topic, message);
    };
}

function subscribeTopics(client) {
    client.subscribe(`${DISPLAY_TOPIC}+`, { noLocal: true });
    client.subscribe(`${DISPLAY_TOPIC}video/+`, { noLocal: true });
    client.subscribe(`${DISPLAY_TOPIC}popup/+/message`, { noLocal: true });
    // QR code and PIN of the pairing (C.4.3.2, C.4.3.3) and notice
    // (C.6.14.5): published on popup/<type>, without /message.
    client.subscribe(`${DISPLAY_TOPIC}popup/+`, { noLocal: true });
    client.subscribe(VIDEO_EVENT_TOPIC, { noLocal: true });
}

function mqttMessage(topic, message) {
    if (topic === VIDEO_EVENT_TOPIC) {
        graphicsEvent('stream_event', { detail: message.toString() });
    }

    const layer = topic.replace(DISPLAY_TOPIC, '');
    if (['graphics', 'rxgui'].includes(layer)) {
        $(`#${layer}`).attr('src', message.toString());
    } else if (layer === 'video/url') {
        setVideoUrl(message.toString());
    } else if (layer === 'video/size') {
        $('#video').css(JSON.parse(message));
    } else if (layer.startsWith('popup')) {
        // Opening, closing and checking of the message: /js/popup.js.
        handlePopupMessage(layer.split('/')[1], message.toString());
    }
}

function instancePlayer(mediaUrl, mediaType) {
    if (player) {
        return;
    }
    player = videojs('video', {
        controls: true,
        autoplay: true,
        muted: true,
        playsinline: true,
        techOrder: ['html5'],
    });
    player.src({ src: mediaUrl, type: mediaType });
    player.play();

    player.on('timeupdate', () => {
        graphicsEvent('timeupdate', { detail: player.currentTime() });
    });

    player.on('error', () => {
        console.warn('Player error — restarting...');
        setTimeout(() => {
            player.src({ src: mediaUrl, type: mediaType });
            player.play();
        }, PLAYER_RESTART_MS);
    });
}

function setVideoUrl(url) {
    if (url === '') {
        if (player && !player.isDisposed()) {
            player.dispose(true);
            player = null;
        }
        if ($('#video').length > 0) {
            $('#video').replaceWith(VIDEO_ELEMENT);
        } else {
            $('#main').prepend(VIDEO_ELEMENT);
        }
        return;
    }

    let mediaType = '';
    if (url.endsWith('mpd')) {
        mediaType = DASH_TYPE;
    } else if (url.endsWith('m3u8')) {
        mediaType = HLS_TYPE;
    }

    if (mediaType === '') {
        $('#video').attr('src', url);
        return;
    }
    try {
        instancePlayer(url, mediaType);
    } catch (err) {
        console.error('Error while processing DASH MPD/HLS M3U8:', err);
    }
}

function relayKey(event) {
    if (yesno_popup) {
        navigate(event.key);
        return;
    }
    event.preventDefault();
    if (PLATFORM_KEYS.includes(event.keyCode)) {
        fetch(`keydown/${event.keyCode}`);
    } else if ($('#rxgui').attr('src') !== '') {
        const keydown = new KeyboardEvent('keydown', { key: event.key });
        $('#rxgui').contents()[0].dispatchEvent(keydown);
    } else if ($('#graphics').attr('src') !== '') {
        graphicsEvent('keydown', { key: event.key });
    }
}

// The broadcaster application runs on its own origin, and the same-origin
// policy prevents dispatching the event in its document: it goes by
// postMessage, only to that origin.
function graphicsEvent(name, init) {
    const frame = document.getElementById('graphics');
    if (!frame.getAttribute('src') || !frame.contentWindow) {
        return;
    }
    const doc = frameDocument(frame);
    if (doc) {
        // Initial document (about:blank) while loading: nothing to notify.
        if (doc.location.href === 'about:blank') {
            return;
        }
        doc.dispatchEvent(localEvent(name, init));
        return;
    }
    const target = new URL(frame.src, window.location.href).origin;
    const message = Object.assign({ type: 'tv30-aop-event', event: name }, init);
    frame.contentWindow.postMessage(message, target);
}

// The document of the frame, or null when its origin is another one.
function frameDocument(frame) {
    try {
        return frame.contentDocument;
    } catch (err) {
        return null;
    }
}

function localEvent(name, init) {
    if (name === 'keydown') {
        return new KeyboardEvent('keydown', { key: init.key });
    }
    return new CustomEvent(name, { detail: init.detail });
}

// The play time of the video element of the page load goes to the graphics
// layer every second.
function postVideoTime(video) {
    const frame = document.getElementById('graphics');
    frame.contentWindow.postMessage({ time: video.currentTime }, '*');
}

document.addEventListener('keydown', relayKey);
connect();
setInterval(postVideoTime, TIME_UPDATE_MS, document.getElementById('video'));
document.getElementById('popup').style.display = 'none';
