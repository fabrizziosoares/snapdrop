class ServerConnection {

    constructor() {
        this._connect();
        Events.on('beforeunload', e => this._disconnect(), false);
        Events.on('pagehide', e => this._disconnect(), false);
        document.addEventListener('visibilitychange', e => this._onVisibilityChange());

    }

    _connect() {
        clearTimeout(this._reconnectTimer);
        if (this._isConnected() || this._isConnecting()) return;
        const ws = new WebSocket(this._endpoint());
        ws.binaryType = 'arraybuffer';
        ws.onopen = e => console.log('WS: server connected');
        ws.onmessage = e => this._onMessage(e.data);
        ws.onclose = e => this._onDisconnect();
        ws.onerror = e => console.error(e);
        this._socket = ws;
    }

    _isConnected() {
        return this._socket && this._socket.readyState === this._socket.OPEN;
    }

    _isConnecting() {
        return this._socket && this._socket.readyState === this._socket.CONNECTING;
    }

    _onMessage(msg) {
        msg = JSON.parse(msg);
        console.log('WS:', msg);
        switch (msg.type) {
            case 'peers':
                Events.fire('peers', msg.peers);
                break;
            case 'peer-joined':
                Events.fire('peer-joined', msg.peer);
                break;
            case 'peer-left':
                Events.fire('peer-left', msg.peerId);
                break;
            case 'signal':
                Events.fire('signal', msg);
                break;
            case 'ping':
                this.send({ type: 'pong' });
                break;
            default:
                console.error('WS: unkown message type', msg)
        }
    }

    send(message) {
        if (this._socket.readyState !== this._socket.OPEN) return;
        this._socket.send(JSON.stringify(message));
    }

    _endpoint() {
        // hack to detect if deployment or development environment
        const protocol = location.protocol.startsWith('https') ? 'wss' : 'ws';
        const host = location.hostname.startsWith('localhost') ? 'localhost:3000' : (location.host + '/server');
        const webrtc = window.isRtcSupported ? '/webrtc' : '/fallback';
        const url = protocol + '://' + host + webrtc;
        return url;
    }

    _disconnect() {
        this.send({ type: 'disconnect' });
        this._socket.close();
    }

    _onDisconnect() {
        console.log('WS: server disconnected');
        Events.fire('notify-user', 'Connection lost. Retry in 5 seconds...');
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(_ => this._connect(), 5000);
    }

    _onVisibilityChange() {
        if (document.hidden) return;
        this._connect();
    }
}

class Peer {

    constructor(serverConnection, peerId) {
        this._server = serverConnection;
        this._peerId = peerId;
        this._filesQueue = [];
        this._busy = false;
    }

    sendJSON(message) {
        this._send(JSON.stringify(message));
    }

    sendFiles(files) {
        for (let i = 0; i < files.length; i++) {
            this._filesQueue.push(files[i]);
        }
        if (this._busy) return;
        this._dequeueFile();
    }

    _dequeueFile() {
        if (!this._filesQueue.length) return;
        this._busy = true;
        const file = this._filesQueue.shift();
        this._sendFile(file);
    }

    _sendFile(file) {
        this.sendJSON({
            type: 'header',
            name: file.name,
            mime: file.type,
            size: file.size,
        });
        this._chunker = new FileChunker(file,
            chunk => this._send(chunk),
            offset => this._onPartitionEnd(offset));
        this._chunker.nextPartition();
    }

    _onPartitionEnd(offset) {
        this.sendJSON({ type: 'partition', offset: offset });
    }

    _onReceivedPartitionEnd(offset) {
        this.sendJSON({ type: 'partition_received', offset: offset });
    }

    _sendNextPartition() {
        if (!this._chunker || this._chunker.isFileEnd()) return;
        this._chunker.nextPartition();
    }

    _sendProgress(progress) {
        this.sendJSON({ type: 'progress', progress: progress });
    }

    _onMessage(message) {
        if (typeof message !== 'string') {
            this._onChunkReceived(message);
            return;
        }
        message = JSON.parse(message);
        console.log('RTC:', message);
        switch (message.type) {
            case 'header':
                this._onFileHeader(message);
                break;
            case 'partition':
                this._onReceivedPartitionEnd(message);
                break;
            case 'partition_received':
                this._sendNextPartition();
                break;
            case 'progress':
                this._onDownloadProgress(message.progress);
                break;
            case 'transfer-complete':
                this._onTransferCompleted();
                break;
            case 'text':
                this._onTextReceived(message);
                break;
        }
    }

    _onFileHeader(header) {
        this._lastProgress = 0;
        this._digester = new FileDigester({
            name: header.name,
            mime: header.mime,
            size: header.size
        }, file => this._onFileReceived(file));
    }

    _onChunkReceived(chunk) {
        this._digester.unchunk(chunk);
        const progress = this._digester.progress;
        this._onDownloadProgress(progress);

        // occasionally notify sender about our progress 
        if (progress - this._lastProgress < 0.01) return;
        this._lastProgress = progress;
        this._sendProgress(progress);
    }

    _onDownloadProgress(progress) {
        Events.fire('file-progress', {
            sender: this._peerId,
            progress: progress
        });
    }

    _onFileReceived(proxyFile) {
        Events.fire('file-received', proxyFile);
        this.sendJSON({ type: 'transfer-complete' });
        // this._digester = null;
    }

    _onTransferCompleted() {
        this._onDownloadProgress(1);
        this._reader = null;
        this._busy = false;
        this._dequeueFile();
        Events.fire('notify-user', 'File transfer completed.');
    }

    sendText(text) {
        this.sendJSON({
            type: 'text',
            text: btoa(unescape(encodeURIComponent(text)))
        });
    }

    _onTextReceived(message) {
        Events.fire('text-received', {
            text: decodeURIComponent(escape(atob(message.text))),
            sender: this._peerId
        });
    }
}

class RTCPeer extends Peer {

    constructor(serverConnection, peerId) {
        super(serverConnection, peerId);
        if (!peerId) return; // we will listen for a caller
        this._start(peerId, true);
    }

    _start(peerId, isCaller) {
        if (!this._peer) {
            this._isCaller = isCaller;
            this._peerId = peerId;
            this._peer = new RTCPeerConnection(RTCPeer.config);
            this._peer.onicecandidate = e => this._onIceCandidate(e);
            this._peer.onconnectionstatechange = e => this._onConnectionStateChange(e);
        }

        if (isCaller) {
            this._createChannel();
        } else {
            this._peer.ondatachannel = e => this._onChannelOpened(e);
        }
    }

    _createChannel() {
        const channel = this._peer.createDataChannel('data-channel', { reliable: true });
        channel.binaryType = 'arraybuffer';
        channel.onopen = e => this._onChannelOpened(e);
        this._peer.createOffer(d => this._onDescription(d), e => this._onError(e));
    }

    _onDescription(description) {
        // description.sdp = description.sdp.replace('b=AS:30', 'b=AS:1638400');
        this._peer.setLocalDescription(description,
            _ => this._sendSignal({ sdp: description }),
            e => this._onError(e));
    }

    _onIceCandidate(event) {
        if (!event.candidate) return;
        this._sendSignal({ ice: event.candidate });
    }

    _sendSignal(signal) {
        signal.type = 'signal';
        signal.to = this._peerId;
        this._server.send(signal);
    }

    onServerMessage(message) {
        if (!this._peer) this._start(message.sender, false);
        const conn = this._peer;

        if (message.sdp) {
            this._peer.setRemoteDescription(new RTCSessionDescription(message.sdp), () => {
                if (message.sdp.type !== 'offer') return;
                this._peer.createAnswer(d => this._onDescription(d), e => this._onError(e));
            }, e => this._onError(e));
        } else if (message.ice) {
            this._peer.addIceCandidate(new RTCIceCandidate(message.ice));
        }
    }

    _onChannelOpened(event) {
        console.log('RTC: channel opened with', this._peerId);
        const channel = event.channel || event.target;
        channel.onmessage = e => this._onMessage(e.data);
        channel.onclose = e => this._onChannelClosed();
        this._channel = channel;
    }

    _onChannelClosed() {
        console.log('RTC: channel closed', this._peerId);
        if (!this.isCaller) return;
        this._start(this._peerId, true); // reopen the channel
    }

    _onConnectionStateChange(e) {
        console.log('RTC: state changed:', this._peer.connectionState);
        switch (this._peer.connectionState) {
            case 'disconnected':
                this._onChannelClosed();
                break;
            case 'failed':
                this._peer = null;
                this._onChannelClosed();
                break;
        }
    }

    _send(message) {
        this._channel.send(message);
    }

    _onError(error) {
        console.error(error);
    }

    refresh() {
        // check if channel open. otherwise create one
        if (this._peer && this._channel && this._channel.readyState !== 'open') return;
        this._start(this._peerId, this._isCaller);
    }
}

class PeersManager {

    constructor(serverConnection) {
        this.peers = {};
        this._server = serverConnection;
        Events.on('signal', e => this._onMessage(e.detail));
        Events.on('peers', e => this._onPeers(e.detail));
        Events.on('files-selected', e => this._onFilesSelected(e.detail));
        Events.on('send-text', e => this._onSendText(e.detail));
        Events.on('peer-left', e => this._onPeerLeft(e.detail));
    }

    _onMessage(message) {
        if (!this.peers[message.sender]) {
            this.peers[message.sender] = new RTCPeer(this._server);
        }
        this.peers[message.sender].onServerMessage(message);
    }

    _onPeers(peers) {
        peers.forEach(peer => {
            if (this.peers[peer.id]) {
                this.peers[peer.id].refresh();
                return;
            }
            if (window.isRtcSupported && peer.rtcSupported) {
                this.peers[peer.id] = new RTCPeer(this._server, peer.id);
            } else {
                this.peers[peer.id] = new WSPeer(this._server, peer.id);
            }
        })
    }

    sendTo(peerId, message) {
        this.peers[peerId].send(message);
    }

    _onFilesSelected(message) {
        this.peers[message.to].sendFiles(message.files);
    }

    _onSendText(message) {
        this.peers[message.to].sendText(message.text);
    }

    _onPeerLeft(peerId) {
        const peer = this.peers[peerId];
        delete this.peers[peerId];
        if (!peer || !peer._peer) return;
        peer._peer.close();
    }

}

class WSPeer {
    _send(message) {
        message.to = this._peerId;
        this._server.send(message);
    }
}

class FileChunker {

    constructor(file, onChunk, onPartitionEnd) {
        this._chunkSize = 64000;
        this._maxPartitionSize = 1e6;
        this._offset = 0;
        this._partitionSize = 0;
        this._file = file;
        this._onChunk = onChunk;
        this._onPartitionEnd = onPartitionEnd;
        this._reader = new FileReader();
        this._reader.addEventListener('load', e => this._onChunkRead(e.target.result));
    }

    nextPartition() {
        this._partitionSize = 0;
        this._readChunk();
    }

    _readChunk() {
        const chunk = this._file.slice(this._offset, this._offset + this._chunkSize);
        this._reader.readAsArrayBuffer(chunk);
    }

    _onChunkRead(chunk) {
        this._offset += chunk.byteLength;
        this._partitionSize += chunk.byteLength;
        this._onChunk(chunk);
        if (this._isPartitionEnd() || this.isFileEnd()) {
            this._onPartitionEnd(this._partitionSize);
            return;
        }
        this._readChunk();
    }

    repeatPartition() {
        this._offset -= this._partitionSize;
        this._nextPartition();
    }

    _isPartitionEnd() {
        return this._partitionSize >= this._maxPartitionSize;
    }

    isFileEnd() {
        return this._offset > this._file.size;
    }

    get progress() {
        return this._offset / this._file.size;
    }
}

class FileDigester {
    constructor(meta, callback) {
        this._buffer = [];
        this._bytesReceived = 0;
        this._size = meta.size;
        this._mime = meta.mime || 'application/octet-stream';
        this._name = meta.name;
        this._callback = callback;
    }

    unchunk(chunk) {
        this._buffer.push(chunk);
        this._bytesReceived += chunk.byteLength || chunk.size;
        const totalChunks = this._buffer.length;
        this.progress = this._bytesReceived / this._size;
        if (this._bytesReceived < this._size) return;

        let received = new Blob(this._buffer, { type: this._mime }); // pass a useful mime type here
        let url = URL.createObjectURL(received);
        this._callback({
            name: this._name,
            mime: this._mime,
            size: this._size,
            url: url
        });
        this._callback = null;
    }
}

class Events {
    static fire(type, detail) {
        window.dispatchEvent(new CustomEvent(type, { detail: detail }));
    }

    static on(type, callback) {
        return window.addEventListener(type, callback, false);
    }
}


window.isRtcSupported = !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection);

RTCPeer.config = {
    'iceServers': [{
        urls: 'stun:stun.stunprotocol.org:3478'
    }, {
        urls: 'stun:stun.l.google.com:19302'
    }, {
        urls: 'turn:turn.bistri.com:80',
        credential: 'homeo',
        username: 'homeo'
    }, {
        urls: 'turn:turn.anyfirewall.com:443?transport=tcp',
        credential: 'webrtc',
        username: 'webrtc'
    }]
}