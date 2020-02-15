import { ContentBlock } from "../playback/ContentBlock";
import { ContentSource } from './ContentSource';
import { MediaObject } from '../playback/MediaObject';
import { Stack } from '../helpers/Stack';
import { LocalFileLocation } from '../playback/MediaLocations';
const ffprobe = require('ffprobe'), ffprobeStatic = require('ffprobe-static');
const path = require('path');
const fs = require('fs');
const uuidv4 = require('uuid/v4');

const supportedVideoExtensions = ['.mp4', '.mkv', '.flv', '.avi', '.m4v', '.mov'];

//Grabs video files in a directory on the local file system
export class LocalDirectorySource extends ContentSource {
    readonly type = 'LocalDirectory';
    private readonly FILE_ACCESS_ERROR = 'FileAccessError';
    private readonly NO_FILES_WARN = 'NoFilesWarning';

    private shuffle : boolean = false;
    private directory : string;
    private videosInFolder : string[];
    private recentVideoPaths : Stack<string> = new Stack(5); 
    //Used to to stop returning the same block too frequently when shuffling,
    //and to keep track of the last video when working alphabetically

    constructor(name: string, directory: string) {
        super(name);
        this.directory = directory;
        this.refresh().catch((err) => console.error('[LocalDirectorySource-' + this.name + '] Refresh failed', err));
    }

    poll() : Promise<ContentBlock> {
        return new Promise((resolve, reject) => {
            this.refreshIfNeeded().then(() => {

                //Pull the next video in the folder alphabetically (uses path rather than index in case new files are added)
                let nextIndex = 0;
                let lastVideoPath = this.recentVideoPaths.getTop();
                if (lastVideoPath != null) {
                    for (let i = 0; i < this.videosInFolder.length; i++) {
                        if (this.videosInFolder[i] === lastVideoPath) {
                            nextIndex = (i + 1);
                            break;
                        }
                    }
                }
                let nextVideoPath = this.videosInFolder[nextIndex];

                mediaObjectFromVideoFile(nextVideoPath).then((mediaObject) => {
                    let contentBlock = new ContentBlock(uuidv4(), mediaObject);
                    this.recentVideoPaths.push(nextVideoPath);
                    resolve(contentBlock);
                }).catch(error => reject(error));

            }).catch(error => reject(error));
        });
    }

    private refreshIfNeeded() : Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.videosInFolder == null) {
                this.refresh().then(() => resolve()).catch(error => reject(error));
            } else {
                resolve();
            }
        });
    }

    refresh() : Promise<void> {
        //Scan the directory for video files
        this.videosInFolder = [];
        return new Promise((resolve, reject) => {
            fs.readdir(this.directory, (err:Error, files:string[]) => {
                if (!err) {
                    for (let filePath of files) {
                        if (supportedVideoExtensions.includes(path.extname(filePath))) {
                            this.videosInFolder.push(path.join(this.directory, filePath));
                        }
                    }

                    //If there are less video files in the directory than the size of the recent video stack, 
                    //reduce the stack size to match
                    if (this.videosInFolder.length <= this.recentVideoPaths.getStackSize()) {
                        this.recentVideoPaths.resizeTo(this.videosInFolder.length - 1);
                    }

                    if (this.shuffle) {
                        this.shuffleArray(this.videosInFolder);
                    }

                    if (this.videosInFolder.length === 0) {
                        this.alerts.warn(this.NO_FILES_WARN, 'No content available', 'There are no supported files in the target directory.');
                    } else {
                        this.alerts.clearAlert(this.NO_FILES_WARN);
                    }

                    this.alerts.clearAlert(this.FILE_ACCESS_ERROR);
                    resolve();
                } else {
                    this.alerts.error(this.FILE_ACCESS_ERROR, 'Refresh failed', "Couldn't access the target directory.");
                    reject(err);
                }
            });
        });
    }

    setShuffle(shouldShuffle : boolean) {
        if (this.shuffle !== shouldShuffle) {
            this.shuffle = shouldShuffle;
            if (this.shuffle === true) {
                this.shuffleArray(this.videosInFolder);
            }
        }
    }

    asJSON() : any {
        return { directory: this.directory, shuffle: this.shuffle };
    }

    shuffleArray(targetArray : any[]){
        var i,j,swap;
        for (i=targetArray.length-1;i>0; i--){
          j = Math.floor(Math.random()* (i+1));
          swap = targetArray[i];
          targetArray[i] = targetArray[j];
          targetArray[j] = swap;
        }
    }
}

export function mediaObjectFromVideoFile(filePath: string) : Promise<MediaObject> {
    const location = new LocalFileLocation(filePath);

    //Use ffProbe to find the video's duration
    return new Promise((resolve, reject) => {
        ffprobe(filePath, { path: ffprobeStatic.path }, (err:Error, info:any) => {
            if (!err) {
                let durationMs = null;
                //Get the duration of the first video stream
                for (let stream of info.streams) {
                    if (stream.codec_type === 'video') {
                        durationMs = stream.duration * 1000;
                        break;
                    }
                }

                if (durationMs == null) {
                    reject('No video stream in file (' + filePath + ')');
                    return;
                }

                let baseFileName = path.basename(filePath); //Remove the file extension from the title
                let title = baseFileName.substring(0, (baseFileName.length - path.extname(filePath).length));
                
                resolve(new MediaObject(MediaObject.MediaType.LocalVideoFile, title, location, durationMs));
            } else {
                reject(err);
            }
        });
    });
}