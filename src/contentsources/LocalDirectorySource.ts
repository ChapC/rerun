import { ContentBlock } from "../playback/ContentBlock";
import { ContentSource } from './ContentSource';
import { MediaObject } from '../playback/MediaObject';
import { Stack } from '../Stack';
const ffprobe = require('ffprobe'), ffprobeStatic = require('ffprobe-static');
const path = require('path');
const fs = require('fs');
const uuidv4 = require('uuid/v4');

const supportedVideoExtensions = ['.mp4', '.mkv', '.flv', '.avi', '.m4v', '.mov'];

//Grabs video files in a directory on the local file system
export class LocalDirectorySource extends ContentSource {
    private directory : string;
    private videosInFolder : string[];
    private recentVideoPaths : Stack<string> = new Stack(5); 
    //Used to to stop returning the same block too frequently when shuffling,
    //and to keep track of the last video when working alphabetically

    constructor(name: string, directory: string) {
        super(name);
        this.directory = directory;
    }

    poll(shuffle:boolean = false) : Promise<ContentBlock> {
        return new Promise((resolve, reject) => {
            this.refreshIfNeeded().then(() => {
                if (shuffle) {
                    //Pick any video from the folder that isn't in recentVideoPaths
                    let recentVideoList = this.recentVideoPaths.getElements();
                    let availableVideos = this.videosInFolder.filter((videoPath) => !recentVideoList.includes(videoPath));

                    let randomIndex = Math.round(Math.random() * (availableVideos.length - 1));

                    mediaObjectFromVideoFile(availableVideos[randomIndex]).then((mediaObject) => {
                        let contentBlock = new ContentBlock(uuidv4(), mediaObject);
                        this.recentVideoPaths.push(contentBlock.media.location.path);
                        resolve(contentBlock);
                    }).catch(error => reject(error));                    
                } else {
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
                }
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
                    resolve();
                } else {
                    reject(err);
                }
            });
        });
    }
}

export function mediaObjectFromVideoFile(filePath: string) : Promise<MediaObject> {
    const location = new MediaObject.Location(MediaObject.Location.Type.LocalURL, filePath);

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
                
                resolve(new MediaObject(MediaObject.Type.LocalVideoFile, title, location, durationMs));
            } else {
                reject(err);
            }
        });
    });
}