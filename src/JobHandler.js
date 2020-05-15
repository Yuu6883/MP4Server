const fs = require("fs");
const uid = require("uid-safe");
const UID_LEN = 36;

// In case running from electron lmao
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path.replace("app.asar", "app.asar.unpacked");;
const { spawn } = require("child_process");

class JobHandler {

    /** @param {import("./MP4Server")} server */
    constructor(server) {
        this.server = server;
        /** @type {Map<string, Job[]>} */
        this.jobs = new Map();
        /** @type {Set<Job>} */
        this.processing = new Set();
    }

    get allJobs() {
        /** @type {Job[]} */
        let jobArr = [];
        this.jobs.forEach(v => jobArr.push(...v));
        return jobArr;
    }

    /**
     * @param {string} ip
     * @param {number} parts
     * @returns {[string, Job]}
     */
    requestJob(ip, parts) {
        if (![2, 4, 8, 16].includes(parts)) return ["Invalid job parts", null];
        if (!this.jobs.has(ip) || this.jobs.get(ip).length < this.server.config.maxJobPerIP) {
            let job = new Job(this, ip, uid.sync(UID_LEN), parts);
            this.jobs.set(ip, (this.jobs.get(ip) || []).concat(job));
            return [null, job];
        } else {
            return ["Please wait till current jobs finish processing", null];
        }
    }

    /** @param {string} id */
    getJob(id) { return this.allJobs.find(j => j.id == id); }

    /** @param {string} id */
    getStatus(id) {
        let job = this.getJob(id);
        if (!job) return;
        return job.status;
    }

    start() {
        if (this.timeout) return this.server.logger.warn("JobHandle already started");
        const wrapper = () => {
            this.process();
            this.timeout = setTimeout(wrapper, this.server.config.processInterval);
        }
        wrapper();
    }

    stop() {
        if (!this.timeout) return this.server.logger.warn("JobHandle is not running");
        clearTimeout(this.timeout);
        delete this.timeout;
    }

    process() {
        if (this.processing.size >= this.server.config.maxConcurrency) return;

        const jobs = this.allJobs.sort((a, b) => a.timestamp - b.timestamp);
        // Spawn jobs yoarrr
        while (jobs.length && this.processing.size < this.server.config.maxConcurrency) {
            const job = jobs.shift();
            if (job.status != "ready") continue;

            // ffmpeg why bruh
            const tempTextFilePath = this.server.getInputPath(job.id) + ".txt";
            let inputFileString = "";
            for (let part = 0; part < job.parts; part++) {
                inputFileString += `file '${this.server.getInputPath(job.id, part)}'\n`;
            }
            fs.writeFileSync(tempTextFilePath, inputFileString, "utf8");

            this.server.logger.debug(`Spawning ffmpeg for Job#${job.id}`);

            job.ffmpeg = spawn(ffmpegPath, [
                '-f', 'concat', 
                '-safe', '0', 
                '-i', tempTextFilePath, 
                '-c', 'copy', 
                this.server.getOutputPath(job.id)
            ]);

            job.ffmpeg.on("exit", code => {
                if (code) this.server.logger.onError(`Job#${job.id} ffmpeg exited with code ${code}`);
                else this.server.logger.debug(`Job#${job.id} finished successfully`);
                job.done = true;
                job.ffmpeg = null;
                this.processing.delete(job);
                fs.unlink(tempTextFilePath, () => {});
            });
            this.processing.add(job);
        }
    }
}

class Job {

    /** 
     * @param {JobHandler} handler
     * @param {string} ip
     * @param {string} id 
     * @param {number} parts
     */
    constructor(handler, ip, id, parts) {
        this.handler = handler;
        this.timestamp = Date.now();
        this.validFrom = ip;
        this.id = id;
        this.parts = parts;
        /** @type {Set<number>} */
        this.receiving = new Set();
        /** @type {Set<number>} */
        this.received = new Set();
        /** @type {import("child_process").ChildProcessWithoutNullStreams} */
        this.ffmpeg = null;
        this.done = false;
    }

    get status() {
        if (this.done) return "done";
        if (this.ffmpeg) return "rendering";
        if (this.received.size == this.parts) return "ready";
        return "pending";
    }

    destroy() {
        this.ffmpeg.removeAllListeners("exit");
        this.ffmpeg.kill("SIGINT");
        this.ffmpeg.once("exit", () => {
            this.deleteInputFiles();
            this.deleteOutputFile();
        });
    }

    deleteInputFiles() {
        for (const part of this.received) {
            const vidPath = this.handler.server.getInputPath(this.id, part);
            fs.exists(vidPath, exists => exists && fs.unlink(vidPath));
        }
        this.received.clear();
    }

    deleteOutputFile() {
        const vidPath = this.handler.server.getOutputPath(this.id);
        fs.exists(vidPath, exists => exists && fs.unlink(vidPath));
    }
}

module.exports = JobHandler;