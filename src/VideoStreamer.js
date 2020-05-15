const fs = require("fs");

/** @param {Buffer} buffer */
const toArrayBuffer = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

module.exports = class VideoStream {
    
    /** @param {import("./MP4Server")} server */
    constructor(server) {
        this.server = server;
        /** @type {Map<string, import("uWebSockets.js").HttpResponse>} */
        this.connections = new Map();
    }

    /**
     * @param {string} ip
     * @param {string} path 
     * @param {import("uWebSockets.js").HttpResponse} res
     * @param {(error: Error) => void} onError
     * @returns {boolean} returns if stream has started
     */
    pipe(ip, path, res, onError) {
        if (this.connections.has(ip)) {
            this.connections.get(ip).close();
        }
        this.connections.set(ip, res);

        if (!fs.existsSync(path)) return false;
        if (this.connections.size >= this.server.config.maxVideoStreams) return false;

        const size = fs.statSync(path).size;
        const readStream = fs.createReadStream(path);

        /** @param {Error} */
        const handleErrorOrAbortOrFinish = (deleteFile, error) => {
            error && onError && onError(error);
            this.connections.delete(ip);
            readStream.destroy();
            deleteFile && fs.unlink(path, () => {});
        }

        /** @type {ArrayBuffer} */
        let toSend = null;
        let lastOffset = 0;

        readStream.on("data", chunk => {
            const buffer = toArrayBuffer(chunk);
            lastOffset = res.getWriteOffset();
            const [ok, done] = res.tryEnd(buffer, size);
            if (done) handleErrorOrAbortOrFinish(true)
            else if (!ok) {
                readStream.pause();
                toSend = buffer;
                
                res.onWritable(offset => {
                    const [ok, done] = res.tryEnd(toSend.slice(offset - lastOffset), size);
                    if (done) handleErrorOrAbortOrFinish(true)
                    else if (ok) {
                        readStream.resume();
                    }
                    return ok;
                });
            }
        }).on("error", error => handleErrorOrAbortOrFinish(true, error));
        res.onAborted(_ => handleErrorOrAbortOrFinish(false));

        return true;
    }
}