# MP4Server
Backend server to concatenate mp4 video segments uploaded from client

# Install & Run
```bash
git clone https://github.com/Yuu6883/MP4Server
cd MP4Server
npm i
cd cli
node index.js
```

# API
* `GET /job?parts=[2|4|8|16]` returns a new job `{ success: boolean, ?id: string, ?error: string }`
* `GET /job/:id` returns job status `"pending" | "ready" | "rendering" | "done"`
* `POST /job/:id/:part` upload the video segment to server
* `GET /job/:id/download` download the concatenated videos

# Config
```js
{
    port: 80,                       // web server port
    cacheTime:  1000,               // time in ms to cache the video segments from client
    maxJobPerIP: 5,                 // maximum open job from an ip
    maxPartSize: 40 * 1024 * 1024,  // max size in bytes of a video segment
    maxConcurrency: 4,              // maxmium ffmpeg processes server can spawn
    processInterval: 500,           // interval to process job queue
    maxVideoStreams: 10,            // maximum stream connection to client
}
```

# Test
Not using any framework, but wrote a simple test script (`test/ConcatTest.js`) that pretty much shows the server works and can be used as an API reference.

# Notes
* This project is mostly a temporary solution I made to concatenate mp4 videos. 
* There's no authentication and job is limited per IP. 
* [uWebsocket.js](https://github.com/uNetworking/uWebSockets.js) is used to serve and handle data stream so the project should have a very high performance. Request handling is mostly copypasta from [uWebsocket.js offical exmaples](https://github.com/uNetworking/uWebSockets.js/tree/master/examples), but wrapped nicely with OOP. 

