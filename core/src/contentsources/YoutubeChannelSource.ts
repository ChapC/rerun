import { MediaObject } from "../playback/MediaObject";
import { URLSearchParams } from "url";
import { getVideoMetadata } from "../YoutubeAPI";
import { Duration } from 'moment';
import { WebVideoDownloader } from "../WebVideoDownloader";
const moment = require('moment');

const urlRegex = new RegExp(/[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/);

export function mediaObjectFromYoutube(videoUrl: string, downloadBuffer: WebVideoDownloader) : Promise<MediaObject> {
    return new Promise((resolve, reject) => {
        //Quick URL regex check
        console.info(videoUrl);
        if (!urlRegex.test(videoUrl)) {
            reject('Invalid URL');
            return;
        }

        const videoId = new URLSearchParams(videoUrl.split('?')[1]).get('v');

        if (videoId == null) {
            reject("Couldn't parse video ID from URL");
            return;
        }

        getVideoMetadata(videoId).then((metadata) => {
            let duration : Duration = moment.duration(metadata.contentDetails.duration); //Duration is in ISO8601 format
            try {
                let media = new MediaObject(
                    MediaObject.MediaType.YouTubeVideo, metadata.snippet.title, 
                    downloadBuffer.bufferYoutubeVideo(videoUrl),
                    duration.asMilliseconds()
                );
                media.thumbnail = metadata.snippet.thumbnails.default.url;
                resolve(media);
            } catch (error) {
                reject(error);
            }
        });
    });
}