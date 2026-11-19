// Page of the TV: the video, graphics and platform interface layers and the
// pop-up element, driven by the aop/display/layers topics. The pop-ups are
// handled by popup.js (handlePopupMessage, yesno_popup).

const DISPLAY_TOPIC = 'aop/display/layers/';
const VIDEO_EVENT_TOPIC = 'video/event';
const MQTT_CONNECT_TIMEOUT_MS = 4000;
// One MQTT client identifier per page: two pages of the TV open at once do
// not take the connection of each other.
const MQTT_CLIENT_ID_PREFIX = 'aop-shell-';
const MQTT_CLIENT_ID_SUFFIX_BYTES = 4;
const MQTT_CLIENT_ID = MQTT_CLIENT_ID_PREFIX + randomHex(MQTT_CLIENT_ID_SUFFIX_BYTES);
const PLAYER_RESTART_MS = 500;
const TIME_UPDATE_MS = 1000;
const VIDEO_ELEMENT = '<video id="video" class="video-js" autoplay muted playsinline></video>';
const DASH_TYPE = 'application/dash+xml';
const HLS_TYPE = 'application/x-mpegURL';
// 27: Escape; 33, 34: PageUp, PageDown; 93: ContextMenu.
const PLATFORM_KEYS = [27, 33, 34, 93];
const HLS_MASTER_TAG = '#EXT-X-STREAM-INF';
const HLS_MEDIA_TAG = '#EXT-X-MEDIA:';
const HLS_MAP_TAG = '#EXT-X-MAP';
const HLS_URI_ATTRIBUTE = /URI="([^"]*)"/;
const HLS_REFUSED_NOTICE_MS = 8000;

let player = null;
let publishTopic = null;
// The last media source asked for: a check of an older one that ends later
// does not start it.
let requestedUrl = '';

// MQTT on the own origin of the page, on /mqtt; the AoP passes it on to the
// broker (src/mqtt-ws.js). location.host is the name and port by which the
// page was opened.
function connect() {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const client = mqtt.connect(`${scheme}://${window.location.host}/mqtt`, {
        clean: true,
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
        setVideoUrl(message.toString()).catch((err) => {
            console.error('Error while processing DASH MPD/HLS M3U8:', err);
        });
    } else if (layer === 'video/size') {
        $('#video').css(JSON.parse(message));
    } else if (layer.startsWith('popup')) {
        // Opening, closing and checking of the message: /js/popup.js.
        handlePopupMessage(layer.split('/')[1], message.toString());
    }
}

// A player already created changes its source (PMPFR-08).
function instancePlayer(mediaUrl, mediaType) {
    if (player) {
        player.src({ src: mediaUrl, type: mediaType });
        startPlayer();
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
    startPlayer();

    player.on('timeupdate', () => {
        graphicsEvent('timeupdate', { detail: player.currentTime() });
    });

    player.on('error', () => {
        console.warn('Player error — restarting...');
        const source = player.currentSource();
        setTimeout(() => {
            player.src(source);
            startPlayer();
        }, PLAYER_RESTART_MS);
    });
}

function startPlayer() {
    const playing = player.play();
    if (playing) {
        playing.catch((err) => {
            console.warn('Player did not start:', err);
        });
    }
}

// An HLS playlist is checked before it goes to the player.
async function setVideoUrl(url) {
    requestedUrl = url;
    if (url === '') {
        stopPlayer();
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
    if (mediaType === HLS_TYPE) {
        const refusal = await hlsRefusal(url);
        if (url !== requestedUrl) {
            return;
        }
        if (refusal !== '') {
            stopPlayer();
            refuseHls(refusal);
            return;
        }
    }
    instancePlayer(url, mediaType);
}

// The player leaves, and a new video element takes its place.
function stopPlayer() {
    if (player && !player.isDisposed()) {
        player.dispose(true);
        player = null;
    }
    if ($('#video').length > 0) {
        $('#video').replaceWith(VIDEO_ELEMENT);
    } else {
        $('#main').prepend(VIDEO_ELEMENT);
    }
}

// ABNT NBR 25602, Annex C: HLS media segments in fragmented MPEG-4 only. A
// media playlist without #EXT-X-MAP has MPEG-2 TS (or packed audio)
// segments. The reason of the refusal, or '' when every media playlist has
// it; a playlist not read is refused.
async function hlsRefusal(url) {
    let text;
    try {
        text = await playlistText(url);
    } catch (err) {
        return `${url}: ${err.message}`;
    }
    if (!text.includes(HLS_MASTER_TAG)) {
        return mediaPlaylistRefusal(url, text);
    }
    for (const mediaUrl of mediaPlaylistUrls(text, url)) {
        let media;
        try {
            media = await playlistText(mediaUrl);
        } catch (err) {
            return `${mediaUrl}: ${err.message}`;
        }
        const refusal = mediaPlaylistRefusal(mediaUrl, media);
        if (refusal !== '') {
            return refusal;
        }
    }
    return '';
}

function mediaPlaylistRefusal(url, text) {
    if (text.includes(HLS_MAP_TAG)) {
        return '';
    }
    return `${url}: sem ${HLS_MAP_TAG}, segmentos MPEG-2 TS`;
}

// The media playlists of a master playlist: the URI after each
// #EXT-X-STREAM-INF and the URI attribute of each #EXT-X-MEDIA, resolved
// against the master playlist.
function mediaPlaylistUrls(text, base) {
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const urls = [];
    lines.forEach((line, index) => {
        if (line.startsWith(HLS_MEDIA_TAG)) {
            const match = HLS_URI_ATTRIBUTE.exec(line);
            if (match) {
                urls.push(new URL(match[1], base).href);
            }
        } else if (line.startsWith(HLS_MASTER_TAG) && index + 1 < lines.length) {
            urls.push(new URL(lines[index + 1], base).href);
        }
    });
    return urls;
}

async function playlistText(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
}

// The refusal goes to the console and to the notice of the pop-up element.
function refuseHls(reason) {
    console.error(`Fluxo HLS recusado: ${reason}`);
    const notice = { value: `Fluxo HLS recusado: ${reason}`, timeout: HLS_REFUSED_NOTICE_MS };
    handlePopupMessage('info', JSON.stringify(notice));
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

// Hexadecimal text of bytes random bytes.
function randomHex(bytes) {
    const values = crypto.getRandomValues(new Uint8Array(bytes));
    return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

document.addEventListener('keydown', relayKey);
connect();
setInterval(postVideoTime, TIME_UPDATE_MS, document.getElementById('video'));
document.getElementById('popup').style.display = 'none';
