const uWS = require("uWebSockets.js");
const path = require("path");
const fs = require("fs");

const Logger = require("./Logger");
const JobHandler = require("./JobHandler");
const FileStreamer = require("./FileStreamer");

const VID_IN_DIR  = path.resolve(__dirname, "..", "vid_in");
const VID_OUT_DIR = path.resolve(__dirname, "..", "vid_out");

const HTTP_200 = "200 OK";
const HTTP_400 = "400 Bad Request";
const HTTP_403 = "403 Forbidden";
const HTTP_404 = "404 Not Found";
const HTTP_413 = "413 Payload Too Large";
const HTTP_500 = "500 Internal Server Error";
const HTTP_503 = "503 Service Unavailable";

/** @param {ArrayBuffer} buffer */
const toIPv4 = buffer => new Uint8Array(buffer).join(".");

class MP4Server {
    
    constructor(config) {

        this.config = {
            port: 80,
            cacheTime:  1000,
            maxJobPerIP: 5,
            maxPartSize: 40 * 1024 * 1024,
            maxConcurrency: 4,
            processInterval: 500,
            maxVideoStreams: 10,
        };
        Object.assign(this.config, config);
        
        this.logger = new Logger();
        this.handler = new JobHandler(this);
        this.streamer = new FileStreamer(this);
        this.listener = null;
    }

    async init() {
        this.clearVideoInput();
        this.clearVideoOutput();
        await this.open(this.config.port);
        this.handler.start();
    }

    open(port) {
        if (this.listener) {
            this.logger.warn("Server already open");
            return;
        }
        return new Promise(resolve => {

            uWS.App()
                .get("/job", (res, req) => {

                    const ip = toIPv4(res.getRemoteAddress());
                    this.logger.onAccess(`Received GET from ${ip} for job request`);

                    const result = req.getQuery().match(/^parts=([1-9]\d*)$/);
                    if (!result) return res.writeStatus(HTTP_400).end();

                    const parts = ~~result[1];
                    const [error, job] = this.handler.requestJob(ip, parts);

                    res.writeHeader("Access-Control-Allow-Origin", "*");

                    if (error) res.end(`{"success": false, "error": "${error}"}`);
                    else res.end(`{"success": true, "id": "${job.id}"}`);
                })
                .get("/job/:id", (res, req) => {

                    const ip = toIPv4(res.getRemoteAddress());
                    let id = req.getParameter(0);
                    let job = this.handler.getJob(id);
                    if (!job) return res.writeStatus(HTTP_404).end();
                    if (job.validFrom != ip) return res.writeStatus(HTTP_403).end();

                    res.writeHeader("Access-Control-Allow-Origin", "*");

                    res.end(`{"status": "${job.status}"}`);
                })
                .post("/job/:id/:part", (res, req) => {

                    const ip = toIPv4(res.getRemoteAddress());
                    const id = req.getParameter(0);
                    const partString = req.getParameter(1);
                    const job = this.handler.getJob(id);
                    this.logger.onAccess(`Received POST from ${ip} for Job#${job ? job.id : "NULL"}`);

                    res.writeHeader("Access-Control-Allow-Origin", "*");

                    // A LOT OF dumb checks
                    if (!job) return res.writeStatus(HTTP_404).end();
                    if (job.validFrom != ip) return res.writeStatus(HTTP_403).end();
                    if (job.status !== "pending") return res.writeStatus(HTTP_400).end();
                    let result = /^\d+$/.exec(partString);
                    if (!result || ~~result[0] != result[0]) return res.writeStatus(HTTP_400).end();
                    const part = ~~result[0];
                    if (part < 0 || part >= job.parts || job.receiving.has(part) || job.received.has(part))
                        return res.writeStatus(HTTP_400).end();
                    const lengthString = req.getHeader("content-length");
                    result = /^\d+$/.exec(lengthString);
                    if (!result || ~~result[0] != result[0]) return res.writeStatus(HTTP_400).end();
                    const contentLength = ~~result[0];
                    if (contentLength <= 0) return res.writeStatus(HTTP_400).end();
                    if (contentLength > this.config.maxPartSize) return res.writeStatus(HTTP_413).end();

                    // Stream to an temp output file
                    let written = 0;
                    const vidPath = this.getInputPath(id, part);
                    const stream = fs.createWriteStream(vidPath);
                    job.receiving.add(id);
                    this.logger.debug(`Adding part#${part} for Job#${id}`);

                    res.onData((chunk, isLast) => {
                        stream.write(Buffer.from(chunk.slice()));
                        written += chunk.byteLength;
                        // ??? Is this even a valid http request ???
                        if (written > contentLength) return res.close();
                        if (isLast) {
                            stream.end(() => {
                                job.receiving.delete(part);
                                job.received.add(part);
                                res.writeStatus(HTTP_200).end();
                            });
                        }
                    });

                    res.onAborted(() => {
                        this.logger.debug(`Error while writing for Job#${job ? job.id : "NULL"}`);
                        fs.unlink(vidPath, () => job.receiving.delete(id));
                    });
                })
                .get("/job/:id/download", (res, req) => {

                    res.writeHeader("Access-Control-Allow-Origin", "*");

                    const ip = toIPv4(res.getRemoteAddress());
                    const id = req.getParameter(0);
                    const job = this.handler.getJob(id);
                    this.logger.onAccess(`Received GET from ${ip} to download Job#${job ? job.id : "NULL"}`);
                    if (!job) return res.writeStatus(HTTP_404).end();
                    if (job.validFrom != ip) return res.writeStatus(HTTP_403).end();

                    let success = this.streamer.pipe(ip, this.getOutputPath(id), res, error => {
                        this.logger.onError(error);
                        res.writeStatus(HTTP_500).end();
                    });

                    if (!success) res.writeStatus(HTTP_503).end();
                })
                .any("/*", (res, req) => {
                    this.logger.debug(`Received request from ${req.getUrl()}`);
                    res.close();
                })
                .listen("0.0.0.0", port, listener => {
                    if (listener) {
                        this.listener = listener;
                        this.logger.inform(`Server opened at port ${port}`);
                    } else {
                        this.logger.inform(`Server failed to open at port ${port}`);
                    }
                    resolve();
                });
        });
    }

    /**
     * @param {string} id 
     * @param {number} part 
     */
    getInputPath(id, part) {
        if (Number.isInteger(part) && part >= 0) return path.resolve(VID_IN_DIR, `${id}-part${part.toString().padStart(2, "0")}.mp4`);
        return path.resolve(VID_IN_DIR, id);
    }

    /** @param {string} id */
    getOutputPath(id) {
        return path.resolve(VID_OUT_DIR, `${id}-output.mp4`);
    }

    stop() {
        this.clearVideoInput();
        this.clearVideoOutput();
        this.handler.stop();
        this.close();
    }

    close() {
        if (!this.listener) return this.logger.warn("Server not opened");
        uWS.us_listen_socket_close(this.listener);
        this.listener = null;
        this.logger.inform("Server closed");
    }

    // Only called once during init
    clearVideoInput() {
        fs.readdir(VID_IN_DIR, (err, files) => err ?
            this.logger.onError(err) : files.forEach(f => fs.unlink(path.resolve(VID_IN_DIR, f), () => {})));
    }

    // Clear all video cache
    clearVideoOutput() {
        const now = Date.now();
        fs.readdir(VID_OUT_DIR, (err, files) => {
            if (err) return this.logger.onError(err);
            for (const file of files) {
                fs.stat(path.resolve(VID_OUT_DIR, file), (err, stats) => {
                    if (err) return this.logger.onError(err);
                    if (now - stats.birthtimeMs > this.config.cacheTime)
                        fs.unlink(path.resolve(VID_OUT_DIR, file), () => {});
                });
            }
        });
    }
}

module.exports = MP4Server;