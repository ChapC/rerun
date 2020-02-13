import { PathLike, existsSync, accessSync, constants as FSConstants, createWriteStream, WriteStream, fstat } from "fs";
import ytdl from 'ytdl-core';
import { WebBufferLocation } from "./playback/MediaLocations";
import { Readable } from "stream";
import { URLSearchParams } from "url";
import FfmpegCommand, { setFfmpegPath } from "fluent-ffmpeg";
const ffmpegStatic = require('ffmpeg-static');
const uuidv4 = require('uuid/v4');

//Handles downloads and manages the on-disk buffer
export class WebVideoDownloader {
    private bufferDirectory : PathLike;
    constructor(bufferDirectory:PathLike) {
        this.bufferDirectory = bufferDirectory;
        if (!existsSync(bufferDirectory)) {
            throw new Error("Buffer directory '" + bufferDirectory + "' does not exist");
        };

        try {
            accessSync(bufferDirectory, FSConstants.F_OK);
        } catch (err) {
            throw new Error("Missing read/write permissions for buffer directory '" + bufferDirectory + "'");
        }

        setFfmpegPath(ffmpegStatic); //Use the static ffmpeg bundled with this package
    }

    private activeJobs: { [id:string] : WebVideoDownloader.DownloadJob } = {};
    getActiveJobs() : {[id:string] : WebVideoDownloader.DownloadJob} {
        return this.activeJobs;
    }

    //Maps a job's download path to its id
    private pathJobIdMap : {[path:string] : string} = {};

    private registerJob(job : WebVideoDownloader.DownloadJob) {
        this.activeJobs[job.getJobId()] = job;
        this.pathJobIdMap[job.getLocalPath()] = job.getJobId();
    }

    private removeJob(jobId : string) {
        let job = this.activeJobs[jobId];
        if (job == null) {
            return;
        }
        delete this.activeJobs[jobId];
        delete this.pathJobIdMap[job.getLocalPath()];
    }

    getJobFromLocation(location: WebBufferLocation) {
        let jobId = this.pathJobIdMap[location.getLocalPath()];
        return this.activeJobs[jobId];
    }
    
    bufferYoutubeVideo(url: string) : WebBufferLocation {
        //Youtube often only includes audio in streams up to 360p, so hd video streams don't have audio
        //To create a video file with both, the highest quality audio stream must be combined with the highest quality video stream

        const videoId = new URLSearchParams(url.split('?')[1]).get('v');
        const finalPath = this.bufferDirectory + '/b-' + videoId + '.mp4';

        //Check if a job for this video is already active
        let existingJob = this.activeJobs[videoId];
        if (existingJob != null) {
            return new WebBufferLocation(url, existingJob); //Return the existing one
        }

        //Check if a combined video has already been downloaded
        if (existsSync(finalPath)) {
            //There should be a job for this file
            this.registerJob(WebVideoDownloader.DownloadJob.getFinishedJob(videoId, finalPath));
            //Return a WebBufferLocation pointing to this file
            return new WebBufferLocation(url, this.activeJobs[videoId]);
        }

        //Best available video
        const vDlJobId = 'v-' + videoId;
        const vDownloadOpts = new YoutubeDownloadOptions(
            url, 
            { quality: 'highestvideo', filter: 'videoonly' }, 
            this.bufferDirectory + '/' + vDlJobId + '.mp4'
        );
        const videoJob = new WebVideoDownloader.YoutubeJob(vDlJobId, vDownloadOpts);

        //Best available audio
        const aDlJobId = 'a-' + videoId;
        const aDownloadOpts = new YoutubeDownloadOptions(
            url, 
            { quality: 'highestaudio', filter: 'audioonly' },
            this.bufferDirectory + '/' + aDlJobId + '.m4v'
        );
        const audioJob = new WebVideoDownloader.YoutubeJob(aDlJobId, aDownloadOpts);

        //Ffmpeg combine job
        const combineJob = new WebVideoDownloader.AVStreamJob(videoId, finalPath, audioJob, videoJob);
        this.registerJob(combineJob);  
        
        return new WebBufferLocation(url, combineJob);
    }
}

export namespace WebVideoDownloader {
    //Represents a video being downloaded from the internet
    export class DownloadJob {
        constructor(protected jobId : string, protected outputPath : string) { }

        start() {}

        protected downloadProgress : number = 0;
        getProgress() : number { return this.downloadProgress; }
        getLocalPath() : string { return this.outputPath; }
        getJobId() : string { return this.jobId; }

        protected errorCallbacks : ((error : Error) => void)[] = [];
        protected finishedCallbacks : (() => void)[] = [];

        onError(callback : (error : Error) => void) {
            this.errorCallbacks.push(callback);
        }

        onFinished(callback : () => void) {
            this.finishedCallbacks.push(callback);
        }

        protected fireErrorCallbacks(error : Error) {
            this.errorCallbacks.forEach(callback => callback(error));
        }

        protected fireFinishedCallbacks() {
            this.finishedCallbacks.forEach(callback => callback());
        }

        static getFinishedJob(jobId: string, outputPath : string) : DownloadJob {
            const finishedJob = new DownloadJob(jobId, outputPath);
            finishedJob.downloadProgress = 100;
            return finishedJob;
        }
    }

    export class YoutubeJob extends DownloadJob {
        videoId: string;
        constructor(jobId: string, private options: YoutubeDownloadOptions) {
            super(jobId, options.writeStreamPath);
            this.videoId = new URLSearchParams(options.url.split('?')[1]).get('v');
        }

        vDlStream: Readable;
        vFileStream: WriteStream;

        start() {
            if (this.vDlStream != null) {
                return; //The job has already started
            }

            console.info('Started YT download job ' + this.options.url);

            this.vFileStream = createWriteStream(this.options.writeStreamPath, {mode: FSConstants.O_CREAT});
            this.vFileStream.on('error', (error) => {
                throw new Error("Couldn't create write stream " + error);
            });

            this.vDlStream = ytdl(this.options.url, this.options.downloadOptions);

            this.vDlStream.pipe(this.vFileStream); //Stream the download into the file

            this.vDlStream.on('progress', (chunkLength: number, downloadedChucks: number, totalChunks: number) => {
                this.downloadProgress = (downloadedChucks / totalChunks) * 100;
            });

            this.vDlStream.on('end', () => this.downloadFinished());

            this.vDlStream.on('error', (error) => this.downloadError(error));
        }

        private downloadFinished() {
            this.vFileStream.close();
            this.downloadProgress = 100;
            this.fireFinishedCallbacks();
        }

        private downloadError(error : Error) {
            this.vFileStream.close();
            this.downloadProgress = -1;
            this.fireErrorCallbacks(error);
        }
    }

    //A DownloadJob where the audio and video streams are downloaded seperately, then combined with ffmpeg
    export class AVStreamJob extends DownloadJob {
        constructor(jobId: string, outputPath : string, private audioJob : DownloadJob, private videoJob : DownloadJob) {
            super(jobId, outputPath);

            //Start the ffmpeg merge once both streams are finished downloading
            audioJob.onFinished(() => {
                if (this.videoJob.getProgress() === 100) {
                    this.startStreamMerge();
                }
            });

            videoJob.onFinished(() => {
                if (this.audioJob.getProgress() === 100) {
                    this.startStreamMerge();
                }
            });

            audioJob.onError((error) => this.onJobFailed(error));
            videoJob.onError((error) => this.onJobFailed(error));

            //Check if the jobs are finished already
            if (this.videoJob.getProgress() === 100 && this.audioJob.getProgress() === 100) {
                this.startStreamMerge();
            }
        }

        start() {
            //Start the audio and video download jobs
            this.audioJob.start();
            this.videoJob.start();
        }

        private startStreamMerge() {
            const merge = FfmpegCommand()
                .input(this.videoJob.getLocalPath())
                .input(this.audioJob.getLocalPath())
                .addOption('-c copy')
                .addOption('-strict experimental') //Required for copying VP9 codec into MP4
                .save(this.outputPath);

            merge.on('start', (command) => {
                console.info('Started ffmpeg with command ' + command);
            });
            
            merge.on('progress', (progress) => {
                //this.ffmpegProgress = progress.percent;
                console.info('ffmpeg progress = ', progress);
            });

            merge.on('end', (stdout, stderr) => {
                console.info('Finished ffmpeg');
                this.ffmpegProgress = 100;

                //Delete the unmerged audio and video files

            });

            merge.on('error', (error) => {
                this.onJobFailed(error);
            });
        }

        private onJobFailed(error : Error) {
            this.ffmpegProgress = -1;
            this.fireErrorCallbacks(error);
        }

        private ffmpegProgress = 0;

        getProgress() : number {
            if (this.ffmpegProgress == -1) {
                return -1; //An error has occurred
            }
            //Combination of audio dl progress, video dl progress and ffmpeg convert progress
            return (this.audioJob.getProgress() + this.videoJob.getProgress() + this.ffmpegProgress) / 3
        }

        toJSON() : any {
            return {
                downloadProgress: this.getProgress()
            }
        }
    }
}

class YoutubeDownloadOptions {
    constructor(public url: string, public downloadOptions: ytdl.downloadOptions, public writeStreamPath: string) {}
}