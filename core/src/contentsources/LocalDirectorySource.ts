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
    //TODO: Use the stack to prevent the same block appearing too frequently when shuffling

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
                            if (nextIndex >= this.videosInFolder.length) {
                                //Wrap around to the start
                                nextIndex = 0;
                                //Re-shuffle the array if set
                                if (this.shuffle) {
                                    this.shuffleArray(this.videosInFolder);
                                }
                            }
                            break;
                        }
                    }
                }

                let nextVideoPath = this.videosInFolder[nextIndex];
                this.recentVideoPaths.push(nextVideoPath);

                mediaObjectFromVideoFile(nextVideoPath).then((mediaObject) => {
                    let contentBlock = new ContentBlock(mediaObject);
                    resolve(contentBlock);
                }).catch(error => reject(error));

            }).catch(error => reject(error));
        });
    }

    private refreshIfNeeded() : Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.videosInFolder == null) { //We haven't scanned yet
                this.refresh().then(() => resolve()).catch(error => reject(error));
            } else {
                //Check if the number of files in the directory have changed since we last refreshed
                this.countFilesIn(this.directory).then((fileCount) => {
                    if (this.videosInFolder.length !== fileCount) {
                        console.info(this.videosInFolder.length + ' vs ' + fileCount);
                        this.refresh().then(() => resolve()).catch(error => reject(error));
                    } else {
                        resolve();
                    }
                }).catch(error => reject(error));
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

    private countFilesIn(directory: string) : Promise<number> {
        return new Promise((resolve, reject) => {
            let supportedFiles = 0;
            fs.readdir(directory, (err:Error, files:string[]) => {
                if (!err) {
                    for (let filePath of files) {
                        if (supportedVideoExtensions.includes(path.extname(filePath))) {
                            supportedFiles++;
                        }
                    }
                    resolve(supportedFiles);
                } else {
                    reject(err);
                }
            });
        });
    }

    private printDirectoryIndex(currentIndex: number) {
        console.info('------------------------------------');
        this.videosInFolder.forEach((video, index) => {
            let vName = path.basename(video);
            if (index === currentIndex) {
                console.info(' -> ' + vName);
            } else {
                console.info(vName);
            }
        });
    }

    asJSON() : any {
        return { directory: this.directory, shuffle: this.shuffle };
    }

    fromAny(object: any) : LocalDirectorySource {
        if (object.directory && object.shuffle && object.name) {
            let newLocalSource = new LocalDirectorySource(object.name, object.directory);
            if (ContentSource.superFromAny(object, newLocalSource)) {
                newLocalSource.setShuffle(object.shuffle);
                return newLocalSource;
            } else {
                return null;
            }
        } else {
            return null;
        }
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

export namespace LocalDirectorySource {
    export function fromAny(object: any) : LocalDirectorySource {
        if (object.directory && object.name) {
            let newLocalSource = new LocalDirectorySource(object.name, object.directory);
            if (ContentSource.superFromAny(object, newLocalSource)) {
                newLocalSource.setShuffle(object.shuffle);
                return newLocalSource;
            } else {
                return null;
            }
        } else {
            return null;
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