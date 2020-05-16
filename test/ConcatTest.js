const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");

const MP4Server = require("../src/MP4Server");
const config = require("../cli/config.js");
const app = new MP4Server(config);

require("../cli/log-handler")(app);

process.once("unhandledRejection", err => app.logger.onFatal(err));
process.once("SIGINT", async () => {
    await app.stop();
    process.exit(0);
});

const TEST_PARTS = 4;
const JOB_URL = "http://localhost/job";
const VID_PATH = path.resolve(__dirname, "vids");
const OUT_PATH = path.resolve(__dirname, "test_output.mp4");

if (fs.existsSync(OUT_PATH)) fs.unlinkSync(OUT_PATH);

app.init().then(async () => {

    /** @type {Response} */
    const jobRes = await fetch(`${JOB_URL}?parts=${TEST_PARTS}`);
    console.assert(jobRes.status == 200, `Failed to request job (Status: ${jobRes.status})`);

    const jobJson = await jobRes.json();
    console.assert(jobJson.success, `Failed to request job (Error: ${jobJson.error})`);
    /** @type {string} */
    const jobId = jobJson.id;
    app.logger.test(`Job requested: ${jobId}`);

    let start = Date.now();
    for (let part = 0; part < TEST_PARTS; part++) {
        const testVidPath = path.resolve(VID_PATH, `test${part}.mp4`);
        const vidBuffer = fs.readFileSync(testVidPath);
        /** @type {Response} */
        const partRes = await fetch(`${JOB_URL}/${jobId}/${part}`, {
            method: "POST",
            body: vidBuffer
        });
        console.assert(partRes.status == 200, `Failed to post job part (Status: ${partRes.status})`);
    }

    app.logger.test(`Upload took: ${(Date.now() - start)}ms`);
    start = Date.now();

    const checkOutput = async () => {
        /** @type {Response} */
        const statusRes = await fetch(`${JOB_URL}/${jobId}`);
        console.assert(statusRes.status == 200, `Failed to get job status (Status: ${statusRes.status})`);

        const statusJson = await statusRes.json();
        app.logger.test(`Job Status: ${statusJson.status}`);
        if (statusJson.status !== "done") setTimeout(checkOutput, 100);
        else {
            
            app.logger.test(`Concat took: ${(Date.now() - start)}ms`);
            start = Date.now();

            /** @type {Response} */
            const downloadRes = await fetch(`${JOB_URL}/${jobId}/download`);
            console.assert(statusRes.status == 200, `Failed to get job download (Status: ${downloadRes.status})`);

            const stream = fs.createWriteStream(OUT_PATH);
            downloadRes.body.pipe(stream);

            stream.on("close", () => {
                app.logger.test(`Download took: ${(Date.now() - start)}ms`);
                app.stop();
            });
        }
    }
    checkOutput();
});